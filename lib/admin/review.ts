import "server-only";
import { z } from "zod";
import { makeSummary } from "@/lib/news/format";
import { employeeIdsAmong, isBlocksArticle, publishPhotoPatch } from "@/lib/submissions/admin";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { currentAdminEmail } from "./session";

export type ReviewResult = { ok: true; warning?: string } | { ok: false; error: string };

export type BulkResult =
  | { ok: true; done: number; failed: { id: string; error: string }[]; warning?: string }
  | { ok: false; error: string };

export const editSchema = z.object({
  headline: z.string().trim().min(1, "Headline is required").max(200, "Headline is too long (max 200)"),
  body: z.string().trim().min(1, "Body is required").max(20_000, "Body is too long"),
});

export type Edits = z.infer<typeof editSchema>;

/** Columns to write. Values are text, null, or (for a Write story's blocks) a JSON document. */
type Patch = Record<string, string | null | object>;

export type ReviewAction = "approve" | "reject" | "unpublish" | "restore" | "mark_relevant";

/** One audit row: who did what to which article, when, and why. */
export type ReviewLogEntry = {
  /** Null for actions on a raw item (mark_relevant). */
  article_id: string | null;
  action: ReviewAction;
  actor_email: string;
  reason: string | null;
  bulk: boolean;
  created_at: string;
  /** mark_relevant: the raw item that was changed. */
  raw_item_id?: string | null;
  /** restore and mark_relevant: the status it had before. */
  previous_status?: string | null;
};

export const MAX_BULK = 50;
export const MAX_REASON = 500;

export type ReviewDeps = {
  /** Admin's email, or null when the caller isn't a signed-in admin. */
  adminEmail: () => Promise<string | null>;
  /** Service-role write on a pending article. Only ever called after adminEmail() succeeded. Returns rows changed. */
  update: (id: string, patch: Patch) => Promise<number>;
  /** Service-role write on a published article (unpublish). Returns rows changed. */
  unpublish: (id: string) => Promise<number>;
  /** Appends audit rows. Only called after the matching update changed a row. */
  log: (entries: ReviewLogEntry[]) => Promise<void>;
  now: () => Date;
  /** Which of these articles are employee submissions. Optional: without it every article is treated as AI-written. */
  employeeIds?: (ids: string[]) => Promise<Set<string>>;
  /**
   * Extra columns to write when an article is published (an employee's photo, copied to the public bucket).
   * Called after the admin check and before the update; if it throws, the article is not published.
   */
  beforePublish?: (id: string) => Promise<Patch>;
  /**
   * Whether the article was written on the Write page. The editor cannot edit blocks here (the page shows them as a preview), so the
   * body and summary are left as they are for those and only the headline can change. Optional: without it every article is plain.
   */
  isBlocks?: (id: string) => Promise<boolean>;
};

export const EMPLOYEE_REASON_REQUIRED = "Give a reason when rejecting an employee's story, so the decision can be explained to the author.";

const NOT_PENDING = "This article is no longer pending review.";
const NOT_PUBLISHED = "This article is no longer published.";
const NOT_ADMIN = "Not authorised.";

const defaultDeps: ReviewDeps = {
  adminEmail: currentAdminEmail,
  async update(id, patch) {
    // Guarded on status so a double click, or two admins, can't act on the same article twice.
    const { data, error } = await supabaseAdmin()
      .from("articles")
      .update(patch)
      .eq("id", id)
      .eq("status", "pending_review")
      .select("id");
    if (error) throw new Error(error.message);
    return data?.length ?? 0;
  },
  async unpublish(id) {
    // Back to the review queue (not deleted), so it can be fixed and re-approved or rejected.
    const { data, error } = await supabaseAdmin()
      .from("articles")
      .update({ status: "pending_review", published_at: null })
      .eq("id", id)
      .eq("status", "published")
      .select("id");
    if (error) throw new Error(error.message);
    return data?.length ?? 0;
  },
  async log(entries) {
    if (entries.length === 0) return;
    const { error } = await supabaseAdmin().from("review_log").insert(entries);
    if (error) throw new Error(error.message);
  },
  now: () => new Date(),
  employeeIds: employeeIdsAmong,
  beforePublish: publishPhotoPatch,
  isBlocks: isBlocksArticle,
};

const message =(err: unknown) => (err instanceof Error ? err.message : String(err));

function cleanReason(reason: unknown): string | null {
  const r = typeof reason === "string" ? reason.trim().slice(0, MAX_REASON) : "";
  return r || null;
}

async function writeLog(entries: ReviewLogEntry[], deps: ReviewDeps): Promise<string | undefined> {
  try {
    await deps.log(entries);
    return undefined;
  } catch (err) {
    // The change itself has been made; say so rather than pretend it failed.
    return `The change was saved but the audit log entry failed: ${message(err)}`;
  }
}

async function run(
  id: string,
  /** "edit" saves text without changing status, so it is not an audit action. */
  action: ReviewAction | "edit",
  build: () => Patch | string | Promise<Patch | string>, // a patch, or an error message
  deps: ReviewDeps,
  reason: string | null = null,
): Promise<ReviewResult> {
  // 1. Admin check first. The service role is not touched before this passes.
  const admin = await deps.adminEmail();
  if (!admin) return { ok: false, error: NOT_ADMIN };
  if (!id) return { ok: false, error: "Missing article id." };

  const patch = await build();
  if (typeof patch === "string") return { ok: false, error: patch };

  try {
    const changed = action === "unpublish" ? await deps.unpublish(id) : await deps.update(id, patch);
    if (changed === 0) return { ok: false, error: action === "unpublish" ? NOT_PUBLISHED : NOT_PENDING };
  } catch (err) {
    return { ok: false, error: `Update failed: ${message(err)}` };
  }

  if (action === "edit") return { ok: true };
  const warning = await writeLog(
    [{ article_id: id, action, actor_email: admin, reason, bulk: false, created_at: deps.now().toISOString() }],
    deps,
  );
  return warning ? { ok: true, warning } : { ok: true };
}

function parseEdits(input: unknown): Edits | string {
  const parsed = editSchema.safeParse(input);
  return parsed.success ? parsed.data : parsed.error.issues.map((i) => i.message).join("; ");
}

/**
 * Publish. If headline/body are given they are validated and saved in the same update, so what the
 * admin sees on screen is what goes live. Nothing is re-run: edited text is not fact-checked again.
 */
export function approveArticle(id: string, edits?: unknown, deps: ReviewDeps = defaultDeps): Promise<ReviewResult> {
  return run(
    id,
    "approve",
    async () => {
      let patch: Patch = { status: "published", published_at: deps.now().toISOString() };
      if (edits !== undefined) {
        const e = parseEdits(edits);
        if (typeof e === "string") return e;
        patch = (await deps.isBlocks?.(id)) ? { ...patch, headline: e.headline } : { ...patch, headline: e.headline, body: e.body, summary: makeSummary(e.body) };
      }
      const extra = await photoPatch(id, deps);
      return typeof extra === "string" ? extra : { ...patch, ...extra };
    },
    deps,
  );
}

/** The photo columns for publishing `id` (empty for AI articles), or an error message. */
async function photoPatch(id: string, deps: ReviewDeps): Promise<Patch | string> {
  if (!deps.beforePublish) return {};
  try {
    return await deps.beforePublish(id);
  } catch (err) {
    return `The story was not published because its photo could not be moved to the public bucket: ${message(err)}`;
  }
}

/** An employee's story cannot be rejected without telling them why; AI articles keep the optional reason. */
async function reasonMissing(ids: string[], reason: string | null, deps: ReviewDeps): Promise<Set<string>> {
  if (reason || !deps.employeeIds) return new Set();
  try {
    return await deps.employeeIds(ids);
  } catch {
    // The lookup failed (for example the origin column does not exist yet): the reason is a courtesy, not a
    // security rule, so rejecting an article must not depend on it.
    return new Set();
  }
}

export function rejectArticle(id: string, deps: ReviewDeps = defaultDeps, reason?: unknown): Promise<ReviewResult> {
  const clean = cleanReason(reason);
  return run(id, "reject", async () => ((await reasonMissing([id], clean, deps)).has(id) ? EMPLOYEE_REASON_REQUIRED : { status: "rejected" }), deps, clean);
}

/** Take a published article off the site and return it to the review queue. */
export function unpublishArticle(id: string, deps: ReviewDeps = defaultDeps): Promise<ReviewResult> {
  return run(id, "unpublish", () => ({}), deps);
}

/** Save headline/body without publishing. */
export function saveArticleEdits(id: string, edits: unknown, deps: ReviewDeps = defaultDeps): Promise<ReviewResult> {
  return run(
    id,
    "edit",
    async (): Promise<Patch | string> => {
      const e = parseEdits(edits);
      if (typeof e === "string") return e;
      return (await deps.isBlocks?.(id)) ? { headline: e.headline } : { headline: e.headline, body: e.body, summary: makeSummary(e.body) };
    },
    deps,
  );
}

// ---------------------------------------------------------------------------
// Bulk
// ---------------------------------------------------------------------------

async function bulk(
  ids: unknown,
  action: "approve" | "reject",
  deps: ReviewDeps,
  reason: string | null,
): Promise<BulkResult> {
  // Same gate as the single actions: nothing else runs, and the service role is untouched, for a non-admin.
  const admin = await deps.adminEmail();
  if (!admin) return { ok: false, error: NOT_ADMIN };

  const unique = [...new Set(Array.isArray(ids) ? ids.filter((i): i is string => typeof i === "string" && i.length > 0) : [])];
  if (unique.length === 0) return { ok: false, error: "Nothing selected." };
  if (unique.length > MAX_BULK) return { ok: false, error: `Select at most ${MAX_BULK} articles at a time.` };

  const when = deps.now().toISOString();
  const patch: Patch = action === "approve" ? { status: "published", published_at: when } : { status: "rejected" };
  const done: string[] = [];
  const failed: { id: string; error: string }[] = [];
  const needsReason = action === "reject" ? await reasonMissing(unique, reason, deps) : new Set<string>();

  for (const id of unique) {
    if (needsReason.has(id)) {
      failed.push({ id, error: EMPLOYEE_REASON_REQUIRED });
      continue;
    }
    try {
      let own = patch;
      if (action === "approve") {
        const extra = await photoPatch(id, deps);
        if (typeof extra === "string") {
          failed.push({ id, error: extra });
          continue;
        }
        own = { ...patch, ...extra };
      }
      if ((await deps.update(id, own)) > 0) done.push(id);
      else failed.push({ id, error: NOT_PENDING });
    } catch (err) {
      failed.push({ id, error: `Update failed: ${message(err)}` });
    }
  }

  const warning = await writeLog(
    done.map((article_id) => ({ article_id, action, actor_email: admin, reason, bulk: true, created_at: when })),
    deps,
  );
  return { ok: true, done: done.length, failed, ...(warning ? { warning } : {}) };
}

/** Publish every selected pending article as it is stored (no edits). */
export function bulkApprove(ids: unknown, deps: ReviewDeps = defaultDeps): Promise<BulkResult> {
  return bulk(ids, "approve", deps, null);
}

/** Reject every selected pending article, with one optional reason recorded on each. */
export function bulkReject(ids: unknown, reason?: unknown, deps: ReviewDeps = defaultDeps): Promise<BulkResult> {
  return bulk(ids, "reject", deps, cleanReason(reason));
}
