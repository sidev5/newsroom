import { SUBMISSION_LIMITS } from "@/lib/config";
import { COUNTRIES } from "@/lib/geo/countries";
import { defaultImagePath } from "@/lib/news/departments";
import { makeSummary } from "@/lib/news/format";
import { checkPhoto, ImageRejected, PHOTO_SIZE_MESSAGE, processPhoto } from "@/lib/submissions/image";
import { decideLimits, IP_LIMIT_MESSAGE, windowStart } from "@/lib/submissions/limits";
import { GENERIC_ERROR, type NewSubmissionArticle, type NewSubmitter, type Sector, type SubmissionDeps } from "@/lib/submissions/service";
import { submissionSlug } from "@/lib/submissions/text";
import { CAPTCHA_ERROR } from "@/lib/submissions/turnstile";
import { blocksToPlainText, firstParagraph, imageBlocks, parseSubmittedDoc, type Block, type BlocksDoc } from "./blocks";
import { storyFieldErrors, storyFieldsSchema, type RawStoryFields, type StoryField } from "./fields";

// Handling of one Write submission, with every outside effect injected (the same SubmissionDeps as the old form).
// The order is: honeypot, human check, validation of the fields, the blocks and the image files (all errors together),
// abuse limits, and only then the expensive work (re-encoding the images, storing them, inserting the rows).

export type StoryImageFile = { size: number; bytes: () => Promise<Uint8Array> };

export type StoryInput = {
  fields: RawStoryFields;
  /** The blocks as the browser sent them (parsed JSON, not trusted). */
  blocks: unknown;
  /** The hidden field. People never fill it in; bots do. */
  honeypot: string;
  captchaToken?: string | null;
  /** The chosen files, by the id of the image block they belong to. */
  images: ReadonlyMap<string, StoryImageFile>;
  ip: string | null;
};

/** invalid: something to fix (field or block errors). limited: too many stories. captcha: the human check failed. server: our side. */
export type StoryResult =
  | { ok: true }
  | {
      ok: false;
      kind: "invalid" | "limited" | "captcha" | "server";
      error?: string;
      fieldErrors?: Partial<Record<StoryField, string>>;
      /** Messages for blocks, by block id. */
      blockErrors?: Record<string, string>;
    };

export const IMAGE_MISSING_MESSAGE = "Choose an image file for this block, or delete the block.";

/** True when this connection already sent its daily limit: checked before the (large) request body is read. */
export async function ipAlreadyLimited(deps: Pick<SubmissionDeps, "store" | "hashIp" | "now">, ip: string | null): Promise<boolean> {
  if (!ip) return false;
  try {
    const counts = await deps.store.counts({ ipHash: deps.hashIp(ip), email: "", sinceIso: windowStart(deps.now(), SUBMISSION_LIMITS.DUPLICATE_WINDOW_HOURS) });
    return counts.ip !== null && counts.ip >= SUBMISSION_LIMITS.MAX_PER_IP_PER_DAY;
  } catch {
    return false; // the real check runs again below
  }
}
export { IP_LIMIT_MESSAGE };

export async function submitBlocksStory(deps: SubmissionDeps, input: StoryInput): Promise<StoryResult> {
  // A bot that fills the hidden field is told it worked; nothing is stored.
  if (input.honeypot.trim() !== "") return { ok: true };

  const logError = deps.logError ?? ((m: string) => console.error(m));
  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

  if (deps.captcha && !(await deps.captcha(input.captchaToken ?? null, input.ip))) return { ok: false, kind: "captcha", error: CAPTCHA_ERROR };

  let sectors: Sector[];
  try {
    sectors = await deps.store.sectors();
  } catch (err) {
    logError(`write: loading sectors failed: ${message(err)}`);
    return { ok: false, kind: "server", error: GENERIC_ERROR };
  }

  // 1. Validation: all the problems together.
  const fields = storyFieldsSchema({ allowedDomains: deps.allowedDomains, sectors: sectors.map((s) => s.slug) }).safeParse(input.fields);
  const fieldErrors: Partial<Record<StoryField, string>> = fields.success ? {} : storyFieldErrors(fields.error);

  const blocks = parseSubmittedDoc(input.blocks);
  const blockErrors: Record<string, string> = {};
  let general: string | undefined;
  if (!blocks.ok) {
    for (const i of blocks.issues) {
      if (i.blockId) blockErrors[i.blockId] ??= i.message;
      else general ??= i.message;
    }
  }

  // The image files: each image block needs one, of the right type and size. Checked on the real bytes.
  const checked = new Map<string, Uint8Array>();
  if (blocks.ok) {
    for (const block of imageBlocks(blocks.doc)) {
      const file = input.images.get(block.id);
      if (!file || file.size <= 0) {
        blockErrors[block.id] = IMAGE_MISSING_MESSAGE;
      } else if (file.size > SUBMISSION_LIMITS.PHOTO_MAX_BYTES) {
        blockErrors[block.id] = PHOTO_SIZE_MESSAGE;
      } else {
        try {
          const bytes = await file.bytes();
          checkPhoto(bytes);
          checked.set(block.id, bytes);
        } catch (err) {
          blockErrors[block.id] = err instanceof ImageRejected ? err.message : "The image could not be read. Please try another file.";
        }
      }
    }
  }

  if (!fields.success || !blocks.ok || Object.keys(blockErrors).length > 0) {
    return {
      ok: false,
      kind: "invalid",
      error: general ?? "Some answers need fixing. They are marked below.",
      fieldErrors,
      blockErrors,
    };
  }

  const data = fields.data;
  const doc = blocks.doc;
  const sector = sectors.find((s) => s.slug === data.sector)!; // the schema only lets listed sectors through
  const now = deps.now();
  const ipHash = input.ip ? deps.hashIp(input.ip) : null;
  const since = windowStart(now, SUBMISSION_LIMITS.DUPLICATE_WINDOW_HOURS);

  // 2. Abuse limits (the same rules as the old form: per email, per connection, no duplicate title).
  try {
    const [counts, recentTitles] = await Promise.all([
      deps.store.counts({ ipHash, email: data.email, sinceIso: since }),
      deps.store.recentTitles(data.email, since),
    ]);
    const decision = decideLimits({ counts: { ip: ipHash ? counts.ip : null, email: counts.email }, title: data.title, recentTitles });
    if (!decision.ok) return { ok: false, kind: "limited", error: decision.message };
  } catch (err) {
    logError(`write: checking limits failed: ${message(err)}`);
    return { ok: false, kind: "server", error: GENERIC_ERROR };
  }

  // 3. The images: decode, strip metadata, resize, store privately. A failure removes what was already stored.
  const id = deps.newId();
  const stored: string[] = [];
  const finished: Block[] = [];
  try {
    for (const block of doc.blocks) {
      if (block.type !== "image") {
        finished.push(block);
        continue;
      }
      const processed = await (deps.processPhoto ?? processPhoto)(checked.get(block.id)!);
      const path = `${id}/${block.id}.webp`;
      await deps.store.uploadPhoto(path, processed.data, processed.contentType);
      stored.push(path);
      finished.push({ id: block.id, type: "image", path, alt: block.alt, caption: block.caption, width: processed.width, height: processed.height });
    }
  } catch (err) {
    await Promise.all(stored.map((p) => deps.store.removePhoto(p).catch(() => {})));
    if (err instanceof ImageRejected) return { ok: false, kind: "invalid", error: err.message };
    logError(`write: storing an image failed: ${message(err)}`);
    return { ok: false, kind: "server", error: GENERIC_ERROR };
  }

  // 4. The rows.
  const stories: BlocksDoc = { v: 1, blocks: finished };
  const body = blocksToPlainText(stories);
  const country = data.country ? COUNTRIES[data.country] : null;
  // The public byline columns hold the author's name only with their consent; the real name stays in the private row.
  const article: NewSubmissionArticle = {
    slug: submissionSlug(data.title, id),
    headline: data.title,
    body,
    summary: data.summary ?? makeSummary(firstParagraph(stories) || body),
    source_urls: [],
    department_id: sector.id,
    status: "pending_review",
    origin: "employee",
    author_first_name: data.showName ? data.firstName : ANONYMOUS_FIRST,
    author_last_name: data.showName ? data.lastName : ANONYMOUS_LAST,
    author_department: data.showName ? data.authorDepartment : null,
    country_code: data.country,
    country_name: country?.name ?? null,
    place: country?.name ?? null,
    image_url: defaultImagePath(sector.slug),
    image_credit: null,
    body_blocks: stories,
    body_format: "blocks",
  };
  const submitter: NewSubmitter = {
    email: data.email,
    ip_hash: ipHash,
    email_verified: deps.allowedDomains.length > 0,
    submitted_at: now.toISOString(),
    image_path: null,
    image_paths: stored,
    first_name: data.firstName,
    last_name: data.lastName,
    author_department: data.authorDepartment,
    name_public: data.showName,
  };
  try {
    await deps.store.insert(article, submitter);
  } catch (err) {
    logError(`write: saving failed: ${message(err)}`);
    await Promise.all(stored.map((p) => deps.store.removePhoto(p).catch(() => {})));
    return { ok: false, kind: "server", error: GENERIC_ERROR };
  }
  return { ok: true };
}

/** What the public byline shows when the author did not agree to show their name. */
export const ANONYMOUS_FIRST = "Newsroom";
export const ANONYMOUS_LAST = "contributor";
