import { createHmac } from "node:crypto";
import { z } from "zod";
import { PUBLIC_IMAGE_PATH } from "@/lib/news/format";
import { ERASE_CONFIRM_WORD } from "./constants";
import { normalizeEmail } from "@/lib/submissions/identity";
import { readerKey } from "@/lib/reader/identity";

// SEC-13: "Delete a person's data". An admin searches by email address, sees what would be removed, confirms, and
// it is done. Every admin function checks the admin first. The audit log never holds the address: only a keyed hash.

export { ERASE_CONFIRM_WORD };

/** anonymize: the byline goes and the story stays. unpublish: the byline goes and a published story also comes off the site. */
export type EraseMode = "anonymize" | "unpublish";

export type PersonArticle = {
  id: string;
  headline: string;
  status: string;
  origin: "ai" | "employee";
  image_url: string | null;
  /** The photo this person sent, waiting in the private bucket (null once it was removed, or when there was none). */
  image_path: string | null;
  /** The images of a Write story that this person sent, still in the private bucket (the author's own files). */
  image_paths?: string[];
  departmentSlug: string | null;
  submittedAt: string | null;
};

export type ErasePlan = {
  /** Keyed hash of the address: what the audit log keeps. */
  subjectHash: string;
  articles: PersonArticle[];
  submitterRows: number;
  /** Files in the private submission-images bucket. */
  privatePhotos: string[];
  /** Files in the public article-images bucket: the story's image, when it is this person's published photo. */
  publicPhotos: string[];
  recipientIds: string[];
  /** Likes and comments this person made as a reader (found through the keyed hash of the address; not tied to a story they wrote). */
  readerLikes: number;
  readerComments: number;
  /** Nothing at all is stored for this address. */
  empty: boolean;
};

export type EraseLogEntry = { admin_email: string; action: "erase_person"; subject_hash: string; detail: Record<string, unknown> };

export type ArticlePatch = {
  author_first_name: null;
  author_last_name: null;
  author_department: null;
  image_credit: null;
  image_url?: string;
  status?: "pending_review";
  published_at?: null;
};

export interface EraseStore {
  /** The stories sent from this (normalized) address, with their submitter row's photo path. */
  submissionsOf(email: string): Promise<PersonArticle[]>;
  /** Ids of the digest_recipients rows with this address. */
  recipientsOf(email: string): Promise<string[]>;
  /** How many likes and comments carry this reader key. */
  readerDataOf(userKey: string): Promise<{ likes: number; comments: number }>;
  /** Deletes the likes, comments, pending sign-in codes and like log of this reader key. Resolves to what was deleted. */
  deleteReaderData(userKey: string): Promise<{ likes: number; comments: number }>;
  /** Removes files from a bucket. `failed` counts the ones that could not be removed (a file already gone is not a failure). */
  removePhotos(bucket: "private" | "public", paths: string[]): Promise<{ failed: number }>;
  updateArticle(id: string, patch: ArticlePatch): Promise<void>;
  deleteRecipients(ids: string[]): Promise<number>;
  deleteSubmitters(articleIds: string[]): Promise<number>;
  log(entry: EraseLogEntry): Promise<void>;
}

export type EraseDeps = {
  store: EraseStore;
  adminEmail: () => Promise<string | null>;
  /** Key of the subject hash (SUBMISSION_HASH_SALT, else CRON_SECRET). */
  secret: string;
  /** The department's default image, which replaces a deleted public photo. */
  defaultImage: (departmentSlug: string | null) => string;
};

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const NOT_ADMIN = "Not authorised.";
const emailSchema = z.email();

/** HMAC-SHA256 of the normalized address, hex. The same person always gets the same value; nobody can go back without the key. */
export function subjectHash(email: string, secret: string): string {
  return createHmac("sha256", secret).update(normalizeEmail(email)).digest("hex");
}

/** The path inside the public bucket of a story image that lives there, or null (a default image, Unsplash, anything else). */
export function publicPhotoPath(imageUrl: string | null): string | null {
  if (!imageUrl) return null;
  try {
    const path = new URL(imageUrl).pathname;
    return path.startsWith(PUBLIC_IMAGE_PATH) && path.length > PUBLIC_IMAGE_PATH.length ? decodeURIComponent(path.slice(PUBLIC_IMAGE_PATH.length)) : null;
  } catch {
    return null;
  }
}

/** What is stored for an address, without changing anything. Admin only. */
export async function planErasure(deps: EraseDeps, rawEmail: string): Promise<Result<{ plan: ErasePlan }>> {
  const admin = await deps.adminEmail();
  if (!admin) return { ok: false, error: NOT_ADMIN };

  const email = normalizeEmail(rawEmail ?? "");
  if (!email || email.length > 254 || !emailSchema.safeParse(email).success) return { ok: false, error: "Enter the person's full email address." };

  const [articles, recipientIds, reader] = await Promise.all([deps.store.submissionsOf(email), deps.store.recipientsOf(email), deps.store.readerDataOf(readerKey(email, deps.secret))]);
  const privatePhotos = [...new Set(articles.flatMap((a) => [a.image_path, ...(a.image_paths ?? [])]).filter((p): p is string => Boolean(p)))];
  const publicPhotos = [...new Set(articles.map((a) => publicPhotoPath(a.image_url)).filter((p): p is string => Boolean(p)))];
  return {
    ok: true,
    plan: {
      subjectHash: subjectHash(email, deps.secret),
      articles,
      submitterRows: articles.length,
      privatePhotos,
      publicPhotos,
      recipientIds,
      readerLikes: reader.likes,
      readerComments: reader.comments,
      empty: articles.length === 0 && recipientIds.length === 0 && reader.likes === 0 && reader.comments === 0,
    },
  };
}

export type EraseOutcome = {
  articles: number;
  unpublished: number;
  submitterRows: number;
  photos: number;
  recipients: number;
  likes: number;
  comments: number;
  /** The data was removed but the audit entry could not be written. */
  warning?: string;
};

/**
 * Does it. Admin only, and only with the confirmation word. The plan is worked out again here, never taken from the
 * form. Order: the photo files first (if one cannot be removed nothing else changes and the admin can try again), then
 * the stories' bylines, the digest recipient, the submitter rows, and last the log entry. A repeat after a failure is safe:
 * what was done is not found again.
 */
export async function eraseData(deps: EraseDeps, rawEmail: string, mode: unknown, confirmation: unknown): Promise<Result<{ outcome: EraseOutcome }>> {
  const admin = await deps.adminEmail();
  if (!admin) return { ok: false, error: NOT_ADMIN };
  if (mode !== "anonymize" && mode !== "unpublish") return { ok: false, error: "Choose what happens to their stories." };
  if (typeof confirmation !== "string" || confirmation.trim() !== ERASE_CONFIRM_WORD) return { ok: false, error: `Type ${ERASE_CONFIRM_WORD} to confirm.` };

  const planned = await planErasure(deps, rawEmail);
  if (!planned.ok) return planned;
  const { plan } = planned;
  if (plan.empty) return { ok: false, error: "Nothing is stored for that address." };

  // 1. Files.
  const priv = plan.privatePhotos.length ? await deps.store.removePhotos("private", plan.privatePhotos) : { failed: 0 };
  const pub = plan.publicPhotos.length ? await deps.store.removePhotos("public", plan.publicPhotos) : { failed: 0 };
  if (priv.failed + pub.failed > 0) {
    return { ok: false, error: `${priv.failed + pub.failed} photo files could not be removed from storage, so nothing was changed. Try again; if it keeps failing check the storage settings.` };
  }

  // 2. The stories: no byline, no photo credit (free text the person typed), and the photo of theirs that was public.
  let unpublished = 0;
  for (const a of plan.articles) {
    const patch: ArticlePatch = { author_first_name: null, author_last_name: null, author_department: null, image_credit: null };
    if (publicPhotoPath(a.image_url)) patch.image_url = deps.defaultImage(a.departmentSlug);
    if (mode === "unpublish" && a.status === "published") {
      patch.status = "pending_review";
      patch.published_at = null;
      unpublished++;
    }
    await deps.store.updateArticle(a.id, patch);
  }

  // 3. The person as a digest recipient, then the submitter rows (email, hashed address, photo path).
  const recipients = plan.recipientIds.length ? await deps.store.deleteRecipients(plan.recipientIds) : 0;
  const submitterRows = plan.articles.length ? await deps.store.deleteSubmitters(plan.articles.map((a) => a.id)) : 0;

  // 3b. What the person did as a reader: their likes and comments (a reader's user key is also the key of their sign-in codes, so those and the like log go too).
  const reader = plan.readerLikes + plan.readerComments > 0 ? await deps.store.deleteReaderData(readerKey(normalizeEmail(rawEmail), deps.secret)) : { likes: 0, comments: 0 };

  const outcome: EraseOutcome = {
    articles: plan.articles.length,
    unpublished,
    submitterRows,
    photos: plan.privatePhotos.length + plan.publicPhotos.length,
    recipients,
    likes: reader.likes,
    comments: reader.comments,
  };

  // 4. The audit entry: who, when (the database's timestamp), the keyed hash, the counts. Never the address.
  try {
    await deps.store.log({
      admin_email: admin,
      action: "erase_person",
      subject_hash: plan.subjectHash,
      detail: { mode, ...outcome },
    });
  } catch (err) {
    outcome.warning = `The data was removed but the audit log entry could not be written: ${err instanceof Error ? err.message : String(err)}`;
  }
  return { ok: true, outcome };
}
