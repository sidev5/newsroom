import "server-only";
import { redactEmails } from "@/lib/privacy";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { currentAdminEmail } from "./session";
import { MAX_BULK, type BulkResult, type ReviewLogEntry, type ReviewResult } from "./review";

// Recovering news that was dropped: rejected articles go back to review, skipped raw items go back
// into the write -> image -> fact-check flow. Admin check first, in every function.

export type RejectedInfo = {
  /** Fact-check report ("- claim" lines); kept on the article when it is restored. */
  fact_check_notes: string | null;
  /** Reason from the latest editor rejection in the audit log, if any. */
  editor_reason: string | null;
};

export type SkippedInfo = {
  status: string;
  department_id: string | null;
  classify_reason: string | null;
};

export type RecoverDeps = {
  adminEmail: () => Promise<string | null>;
  /** Articles in the given ids that are currently 'rejected'. Missing ids are simply absent. */
  loadRejected: (ids: string[]) => Promise<Map<string, RejectedInfo>>;
  /** Service-role write, guarded on status 'rejected'. Returns rows changed. */
  restore: (id: string, patch: { status: "pending_review"; review_note: string }) => Promise<number>;
  /** Raw items in the given ids that are currently 'skipped' or 'failed'. */
  loadSkipped: (ids: string[]) => Promise<Map<string, SkippedInfo>>;
  /** Ids of all departments, to validate a picked department. */
  departmentIds: () => Promise<Set<string>>;
  /** Service-role write, guarded on status 'skipped' or 'failed'. Returns rows changed. */
  markRelevant: (id: string, patch: { status: "new-relevant"; department_id: string; classify_reason: string }) => Promise<number>;
  log: (entries: ReviewLogEntry[]) => Promise<void>;
  now: () => Date;
};

const NOT_ADMIN = "Not authorised.";
const NOT_REJECTED = "This article is no longer rejected.";
const NOT_SKIPPED = "This item is no longer skipped or failed.";
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

const defaultDeps: RecoverDeps = {
  adminEmail: currentAdminEmail,
  async loadRejected(ids) {
    const db = supabaseAdmin();
    const { data, error } = await db.from("articles").select("id, fact_check_notes").in("id", ids).eq("status", "rejected");
    if (error) throw new Error(error.message);
    const out = new Map<string, RejectedInfo>();
    for (const r of (data ?? []) as { id: string; fact_check_notes: string | null }[]) {
      out.set(r.id, { fact_check_notes: r.fact_check_notes, editor_reason: null });
    }
    if (out.size === 0) return out;
    // Latest editor rejection per article. A missing log table just means no editor reasons.
    const logs = await db
      .from("review_log")
      .select("article_id, action, reason")
      .in("article_id", [...out.keys()])
      .order("created_at", { ascending: false });
    const done = new Set<string>();
    for (const l of (logs.data ?? []) as { article_id: string; action: string; reason: string | null }[]) {
      if (done.has(l.article_id)) continue;
      done.add(l.article_id);
      if (l.action === "reject") out.get(l.article_id)!.editor_reason = l.reason;
    }
    return out;
  },
  async restore(id, patch) {
    // Guarded on status so a double click, or two admins, cannot restore twice. fact_check_notes is untouched.
    const { data, error } = await supabaseAdmin().from("articles").update(patch).eq("id", id).eq("status", "rejected").select("id");
    if (error) throw new Error(error.message);
    return data?.length ?? 0;
  },
  async loadSkipped(ids) {
    const { data, error } = await supabaseAdmin()
      .from("raw_items")
      .select("id, status, department_id, classify_reason")
      .in("id", ids)
      .in("status", ["skipped", "failed"]);
    if (error) throw new Error(error.message);
    return new Map(
      ((data ?? []) as (SkippedInfo & { id: string })[]).map((r) => [r.id, { status: r.status, department_id: r.department_id, classify_reason: r.classify_reason }]),
    );
  },
  async departmentIds() {
    const { data, error } = await supabaseAdmin().from("departments").select("id");
    if (error) throw new Error(error.message);
    return new Set(((data ?? []) as { id: string }[]).map((d) => d.id));
  },
  async markRelevant(id, patch) {
    const { data, error } = await supabaseAdmin().from("raw_items").update(patch).eq("id", id).in("status", ["skipped", "failed"]).select("id");
    if (error) throw new Error(error.message);
    return data?.length ?? 0;
  },
  async log(entries) {
    if (entries.length === 0) return;
    const { error } = await supabaseAdmin().from("review_log").insert(entries);
    if (error) throw new Error(error.message);
  },
  now: () => new Date(),
};

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

const NOTE_MAX = 1500;

/** Claims from a fact-check report stored as "- claim" lines. */
export function flaggedClaims(factCheckNotes: string | null): string[] {
  return (factCheckNotes ?? "")
    .split("\n")
    .map((l) => l.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean);
}

/**
 * The visible note on a restored article: what the fact-check had flagged, or why an editor had rejected it.
 * review_note is a column the public site can read, so the note never names the admin (who restored it is in
 * review_log) and any email address typed in a reason is blanked.
 */
export function restoreNote(info: RejectedInfo): string {
  const claims = flaggedClaims(info.fact_check_notes);
  const note = claims.length
    ? `Restored by an editor, fact-check had flagged: ${claims.join("; ")}`
    : info.editor_reason
      ? `Restored by an editor; it had been rejected by an editor: ${info.editor_reason}`
      : "Restored by an editor; it had been rejected with no recorded reason.";
  return redactEmails(note).slice(0, NOTE_MAX);
}

/** classify_reason after an editor marks an item relevant: keeps what the classifier said. */
export function markedReason(admin: string, previous: string | null): string {
  const base = `marked relevant by ${admin}`;
  return (previous ? `${base} (was: ${previous})` : base).slice(0, 500);
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function cleanIds(ids: unknown): string[] {
  return [...new Set(Array.isArray(ids) ? ids.filter((i): i is string => typeof i === "string" && i.length > 0) : [])];
}

async function writeLog(entries: ReviewLogEntry[], deps: RecoverDeps): Promise<string | undefined> {
  if (entries.length === 0) return undefined; // nothing changed, nothing to record
  try {
    await deps.log(entries);
    return undefined;
  } catch (err) {
    return `The change was saved but the audit log entry failed: ${message(err)}`;
  }
}

function single(result: BulkResult): ReviewResult {
  if (!result.ok) return result;
  if (result.failed.length) return { ok: false, error: result.failed[0].error };
  return result.warning ? { ok: true, warning: result.warning } : { ok: true };
}

// ---------------------------------------------------------------------------
// Restore rejected articles to review
// ---------------------------------------------------------------------------

async function restoreMany(rawIds: unknown, bulk: boolean, deps: RecoverDeps): Promise<BulkResult> {
  // 1. Admin check first. The service role is not touched before this passes.
  const admin = await deps.adminEmail();
  if (!admin) return { ok: false, error: NOT_ADMIN };

  const ids = cleanIds(rawIds);
  if (ids.length === 0) return { ok: false, error: "Nothing selected." };
  if (ids.length > MAX_BULK) return { ok: false, error: `Select at most ${MAX_BULK} articles at a time.` };

  let infos: Map<string, RejectedInfo>;
  try {
    infos = await deps.loadRejected(ids);
  } catch (err) {
    return { ok: false, error: `Loading failed: ${message(err)}` };
  }

  const when = deps.now().toISOString();
  const entries: ReviewLogEntry[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const id of ids) {
    const info = infos.get(id);
    if (!info) {
      failed.push({ id, error: NOT_REJECTED });
      continue;
    }
    try {
      const changed = await deps.restore(id, { status: "pending_review", review_note: restoreNote(info) });
      if (changed === 0) {
        failed.push({ id, error: NOT_REJECTED });
        continue;
      }
      entries.push({ article_id: id, action: "restore", actor_email: admin, reason: null, bulk, created_at: when, previous_status: "rejected" });
    } catch (err) {
      failed.push({ id, error: `Update failed: ${message(err)}` });
    }
  }

  const warning = await writeLog(entries, deps);
  return { ok: true, done: entries.length, failed, ...(warning ? { warning } : {}) };
}

/** Put a rejected article back in Pending. The fact-check report is kept and a visible note is added. */
export async function restoreArticle(id: string, deps: RecoverDeps = defaultDeps): Promise<ReviewResult> {
  return single(await restoreMany(id ? [id] : [], false, deps));
}

export function bulkRestore(ids: unknown, deps: RecoverDeps = defaultDeps): Promise<BulkResult> {
  return restoreMany(ids, true, deps);
}

// ---------------------------------------------------------------------------
// Mark skipped raw items relevant
// ---------------------------------------------------------------------------

async function markMany(rawIds: unknown, departmentId: string | null, bulk: boolean, deps: RecoverDeps): Promise<BulkResult> {
  const admin = await deps.adminEmail();
  if (!admin) return { ok: false, error: NOT_ADMIN };

  const ids = cleanIds(rawIds);
  if (ids.length === 0) return { ok: false, error: "Nothing selected." };
  if (ids.length > MAX_BULK) return { ok: false, error: `Select at most ${MAX_BULK} items at a time.` };

  let infos: Map<string, SkippedInfo>;
  let departments: Set<string>;
  try {
    [infos, departments] = await Promise.all([deps.loadSkipped(ids), deps.departmentIds()]);
  } catch (err) {
    return { ok: false, error: `Loading failed: ${message(err)}` };
  }
  if (departmentId && !departments.has(departmentId)) return { ok: false, error: "Unknown department." };

  const when = deps.now().toISOString();
  const entries: ReviewLogEntry[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const id of ids) {
    const info = infos.get(id);
    if (!info) {
      failed.push({ id, error: NOT_SKIPPED });
      continue;
    }
    // A picked department wins; otherwise the classifier's own guess is kept.
    const dept = departmentId ?? info.department_id;
    if (!dept || !departments.has(dept)) {
      failed.push({ id, error: "Pick a department: this item has none." });
      continue;
    }
    try {
      const changed = await deps.markRelevant(id, {
        status: "new-relevant",
        department_id: dept,
        classify_reason: markedReason(admin, info.classify_reason),
      });
      if (changed === 0) {
        failed.push({ id, error: NOT_SKIPPED });
        continue;
      }
      entries.push({
        article_id: null,
        raw_item_id: id,
        action: "mark_relevant",
        actor_email: admin,
        reason: info.classify_reason?.slice(0, 500) ?? null,
        bulk,
        created_at: when,
        previous_status: info.status,
      });
    } catch (err) {
      failed.push({ id, error: `Update failed: ${message(err)}` });
    }
  }

  const warning = await writeLog(entries, deps);
  return { ok: true, done: entries.length, failed, ...(warning ? { warning } : {}) };
}

/** Set a skipped or failed raw item to 'new-relevant' so write -> image -> fact-check picks it up. */
export async function markRelevant(id: string, departmentId: string | null, deps: RecoverDeps = defaultDeps): Promise<ReviewResult> {
  return single(await markMany(id ? [id] : [], departmentId, false, deps));
}

/** departmentId null keeps each item's own department guess. */
export function bulkMarkRelevant(ids: unknown, departmentId: string | null, deps: RecoverDeps = defaultDeps): Promise<BulkResult> {
  return markMany(ids, departmentId, true, deps);
}
