import { SUBMISSION_LIMITS } from "@/lib/config";
import { COUNTRIES } from "@/lib/geo/countries";
import { defaultImagePath } from "@/lib/news/departments";
import { makeSummary } from "@/lib/news/format";
import { checkPhoto, ImageRejected, PHOTO_SIZE_MESSAGE, processPhoto, type ProcessedPhoto } from "./image";
import { decideLimits, windowStart, type LimitCounts } from "./limits";
import { fieldErrors, submissionSchema, type FormField, type RawSubmission } from "./schema";
import { submissionSlug } from "./text";
import type { BlocksDoc } from "@/lib/stories/blocks";
import { CAPTCHA_ERROR } from "./turnstile";

// Handling of one /submit request, with every outside effect injected so the rules can be tested.
// The order is: honeypot, validation (cheap), abuse limits (one query each), and only then the expensive
// work (decoding the photo, storing it, inserting the rows).

export type Sector = { id: string; slug: string; name: string };

/** The row stored in `articles`. Public columns only: the author's email lives in article_submitters. */
export type NewSubmissionArticle = {
  slug: string;
  headline: string;
  body: string;
  /** First 240 characters of the body, for the feed cards. */
  summary: string;
  source_urls: string[];
  department_id: string;
  status: "pending_review";
  origin: "employee";
  author_first_name: string;
  author_last_name: string;
  author_department: string | null;
  country_code: string | null;
  country_name: string | null;
  place: string | null;
  /** The department default image when there is no photo; null while a photo waits in the private bucket. */
  image_url: string | null;
  image_credit: string | null;
  /** Stories written on the Write page only (columns from 2026-10-22_story_blocks.sql): the blocks, whose images are still private paths. */
  body_blocks?: BlocksDoc;
  body_format?: "blocks";
};

/** The private row (RLS denies all public access). */
export type NewSubmitter = {
  email: string;
  /** Keyed hash of the network address; null when the address was unknown. Never the raw IP. */
  ip_hash: string | null;
  /** True when the address was checked against ALLOWED_EMAIL_DOMAINS. False: no domain list is configured. */
  email_verified: boolean;
  submitted_at: string;
  /** Object path in the private bucket; null without a photo. */
  image_path: string | null;
  /** Write stories only: the images of the blocks in the private bucket, the author's real name (the public byline may be anonymous), and whether it is shown. */
  image_paths?: string[];
  first_name?: string;
  last_name?: string;
  author_department?: string;
  name_public?: boolean;
};

export interface SubmissionStore {
  /** Company departments a story can be filed under. */
  sectors(): Promise<Sector[]>;
  counts(args: { ipHash: string | null; email: string; sinceIso: string }): Promise<LimitCounts>;
  /** Titles this email sent since `sinceIso`. */
  recentTitles(email: string, sinceIso: string): Promise<string[]>;
  uploadPhoto(path: string, data: Buffer, contentType: string): Promise<void>;
  removePhoto(path: string): Promise<void>;
  /** Inserts the article and its submitter row together; neither is kept if the second insert fails. */
  insert(article: NewSubmissionArticle, submitter: NewSubmitter): Promise<{ id: string }>;
}

export type SubmissionDeps = {
  store: SubmissionStore;
  allowedDomains: readonly string[];
  hashIp: (ip: string) => string;
  now: () => Date;
  newId: () => string;
  processPhoto?: (bytes: Uint8Array) => Promise<ProcessedPhoto>;
  /** Where unexpected errors go. Receives a message without personal data. */
  logError?: (message: string) => void;
  /** Cloudflare Turnstile (optional). Present: every submission needs a token that passes. Absent: no check. */
  captcha?: (token: string | null, ip: string | null) => Promise<boolean>;
};

export type SubmitInput = {
  fields: RawSubmission;
  /** The hidden field. People never fill it in; bots do. */
  honeypot: string;
  /** The Turnstile token of the form (cf-turnstile-response), when the check is on. */
  captchaToken?: string | null;
  /** The chosen file, if any. `bytes` is only called after the size is known to be acceptable. */
  photo: { size: number; bytes: () => Promise<Uint8Array> } | null;
  ip: string | null;
};

export type SubmitResult =
  | { ok: true }
  | { ok: false; error?: string; fieldErrors?: Partial<Record<FormField, string>> };

export const GENERIC_ERROR = "Something went wrong on our side and your story was not saved. Please try again in a few minutes.";

export async function submitStory(deps: SubmissionDeps, input: SubmitInput): Promise<SubmitResult> {
  // A bot that fills the hidden field is told it worked; nothing is stored.
  if (input.honeypot.trim() !== "") return { ok: true };

  const logError = deps.logError ?? ((m: string) => console.error(m));
  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

  // The optional human check comes before anything is read or stored.
  if (deps.captcha && !(await deps.captcha(input.captchaToken ?? null, input.ip))) return { ok: false, error: CAPTCHA_ERROR };

  let sectors: Sector[];
  try {
    sectors = await deps.store.sectors();
  } catch (err) {
    logError(`submission: loading sectors failed: ${message(err)}`);
    return { ok: false, error: GENERIC_ERROR };
  }

  // 1. Validation. Field errors are all reported together, including the photo's size and type.
  const parsed = submissionSchema({ allowedDomains: deps.allowedDomains, sectors: sectors.map((s) => s.slug) }).safeParse(input.fields);
  const errors: Partial<Record<FormField, string>> = parsed.success ? {} : fieldErrors(parsed.error);

  let photoBytes: Uint8Array | null = null;
  if (input.photo && input.photo.size > 0) {
    if (input.photo.size > SUBMISSION_LIMITS.PHOTO_MAX_BYTES) {
      errors.photo = PHOTO_SIZE_MESSAGE;
    } else {
      try {
        photoBytes = await input.photo.bytes();
        checkPhoto(photoBytes);
      } catch (err) {
        errors.photo = err instanceof ImageRejected ? err.message : "The photo could not be read. Please try another file.";
        photoBytes = null;
      }
    }
  }
  if (!parsed.success || Object.keys(errors).length > 0) {
    return { ok: false, error: "Some answers need fixing. They are marked below.", fieldErrors: errors };
  }

  const data = parsed.data;
  const sector = sectors.find((s) => s.slug === data.sector)!; // the schema only lets listed sectors through
  const now = deps.now();
  const ipHash = input.ip ? deps.hashIp(input.ip) : null;
  const since = windowStart(now, SUBMISSION_LIMITS.DUPLICATE_WINDOW_HOURS);

  // 2. Abuse limits.
  let decision;
  try {
    const [counts, recentTitles] = await Promise.all([
      deps.store.counts({ ipHash, email: data.email, sinceIso: since }),
      deps.store.recentTitles(data.email, since),
    ]);
    decision = decideLimits({ counts: { ip: ipHash ? counts.ip : null, email: counts.email }, title: data.title, recentTitles });
  } catch (err) {
    logError(`submission: checking limits failed: ${message(err)}`);
    return { ok: false, error: GENERIC_ERROR };
  }
  if (!decision.ok) return { ok: false, error: decision.message };

  // 3. The photo: decode, strip metadata, resize, store privately.
  const id = deps.newId();
  let photoPath: string | null = null;
  if (photoBytes) {
    try {
      const processed = await (deps.processPhoto ?? processPhoto)(photoBytes);
      photoPath = `${id}.webp`;
      await deps.store.uploadPhoto(photoPath, processed.data, processed.contentType);
    } catch (err) {
      if (err instanceof ImageRejected) return { ok: false, error: "The photo has a problem.", fieldErrors: { photo: err.message } };
      logError(`submission: storing the photo failed: ${message(err)}`);
      return { ok: false, error: GENERIC_ERROR };
    }
  }

  // 4. The rows.
  const country = data.country ? COUNTRIES[data.country] : null;
  const article: NewSubmissionArticle = {
    slug: submissionSlug(data.title, id),
    headline: data.title,
    body: data.text,
    summary: makeSummary(data.text),
    source_urls: [],
    department_id: sector.id,
    status: "pending_review",
    origin: "employee",
    author_first_name: data.firstName,
    author_last_name: data.lastName,
    author_department: data.authorDepartment,
    country_code: data.country,
    country_name: country?.name ?? null,
    place: country?.name ?? null,
    image_url: photoPath ? null : defaultImagePath(sector.slug),
    image_credit: photoPath ? data.photoCredit : null,
  };
  const submitter: NewSubmitter = {
    email: data.email,
    ip_hash: ipHash,
    email_verified: deps.allowedDomains.length > 0,
    submitted_at: now.toISOString(),
    image_path: photoPath,
  };
  try {
    await deps.store.insert(article, submitter);
  } catch (err) {
    logError(`submission: saving failed: ${message(err)}`);
    if (photoPath) await deps.store.removePhoto(photoPath).catch(() => {});
    return { ok: false, error: GENERIC_ERROR };
  }
  return { ok: true };
}
