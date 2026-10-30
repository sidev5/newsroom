"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ADMIN_ACTIVITY_COOKIE } from "@/lib/admin/activity";
import { errorCodeFor, isNotAuthorised, LOGIN_EXPIRED_PATH, bannerParams, type NoticeCode } from "@/lib/admin/messages";
import { raiseTodaysLimit } from "@/lib/admin/budget-admin";
import { runOneStage } from "@/lib/admin/pipeline";
import { bulkMarkRelevant, bulkRestore, markRelevant, restoreArticle } from "@/lib/admin/recover";
import {
  approveArticle,
  bulkApprove,
  bulkReject,
  rejectArticle,
  saveArticleEdits,
  unpublishArticle,
  type BulkResult,
  type ReviewResult,
} from "@/lib/admin/review";
import { parseTab } from "@/lib/admin/review-view";
import { revalidatePublicSite } from "@/lib/news/revalidate";
import { isStageName } from "@/lib/pipeline/stage-names";
import { hideComment, unhideComment } from "@/lib/stories/moderation";
import { moderationDeps } from "@/lib/stories/moderation-store";
import { supabaseServer } from "@/lib/supabase/server";

// Each action re-checks the admin in lib/admin/*; hiding the buttons is not the protection.
// The banner after an action is a code in the URL, mapped to fixed wording in lib/admin/messages.ts.

const field = (form: FormData, name: string) => String(form.get(name) ?? "");

/** Back to the tab and filter the admin was on, with a banner (codes only). */
function back(form: FormData, params: Record<string, string>): never {
  revalidatePath("/admin/review");
  const query = new URLSearchParams({ tab: parseTab(form.get("tab")) });
  const dept = field(form, "dept");
  if (dept) query.set("dept", dept);
  for (const [k, v] of Object.entries(params)) query.set(k, v);
  redirect(`/admin/review?${query}`);
}

/** A failed action. An expired session goes to the login page; anything else becomes a coded banner. */
function fail(form: FormData, error: string, id?: string): never {
  if (isNotAuthorised(error)) redirect(LOGIN_EXPIRED_PATH);
  back(form, { ...bannerParams({ error: errorCodeFor(error) }), ...(id ? { article: id } : {}) });
}

function done(form: FormData, result: ReviewResult, id: string, notice: NoticeCode): never {
  if (!result.ok) fail(form, result.error, id);
  if (result.warning) console.error(`admin action: ${result.warning}`);
  // Approve, unpublish, restore and edit all change what the public pages may show: drop their cache now.
  revalidatePublicSite();
  back(form, bannerParams({ notice, warn: Boolean(result.warning) }));
}

export async function approveAction(form: FormData) {
  const id = field(form, "id");
  done(form, await approveArticle(id, { headline: field(form, "headline"), body: field(form, "body") }), id, "published");
}

export async function rejectAction(form: FormData) {
  const id = field(form, "id");
  done(form, await rejectArticle(id, undefined, field(form, "reason")), id, "rejected");
}

export async function saveAction(form: FormData) {
  const id = field(form, "id");
  done(form, await saveArticleEdits(id, { headline: field(form, "headline"), body: field(form, "body") }), id, "saved");
}

/** A comment hidden or shown again: it is not cached anywhere, so only the admin page is refreshed. */
function commentDone(form: FormData, result: ReviewResult, notice: NoticeCode): never {
  if (!result.ok) fail(form, result.error);
  if (result.warning) console.error(`dmin action: ${result.warning}`);
  back(form, bannerParams({ notice, warn: Boolean(result.warning) }));
}

export async function hideCommentAction(form: FormData) {
  commentDone(form, await hideComment(moderationDeps(), field(form, "id"), field(form, "reason")), "comment_hidden");
}

export async function unhideCommentAction(form: FormData) {
  commentDone(form, await unhideComment(moderationDeps(), field(form, "id")), "comment_shown");
}

export async function unpublishAction(form: FormData) {
  const id = field(form, "id");
  done(form, await unpublishArticle(id), id, "unpublished");
}

function bulkDone(form: FormData, result: BulkResult, notice: NoticeCode): never {
  if (!result.ok) fail(form, result.error);
  if (result.warning) console.error(`admin action: ${result.warning}`);
  if (result.done > 0) revalidatePublicSite();
  // Every reason is logged; the banner names the first one.
  const why = result.failed.length ? errorCodeFor(result.failed[0].error) : undefined;
  for (const f of result.failed.slice(1)) errorCodeFor(f.error);
  back(form, bannerParams({ notice, n: result.done, k: result.failed.length, why, warn: Boolean(result.warning) }));
}

/** The confirmation step in the UI posts confirm=yes; a stray or scripted submit without it does nothing. */
const confirmed = (form: FormData) => field(form, "confirm") === "yes";

export async function bulkApproveAction(form: FormData) {
  if (!confirmed(form)) back(form, bannerParams({ error: "needs_confirmation" }));
  bulkDone(form, await bulkApprove(form.getAll("ids").map(String)), "bulk_published");
}

export async function bulkRejectAction(form: FormData) {
  if (!confirmed(form)) back(form, bannerParams({ error: "needs_confirmation" }));
  bulkDone(form, await bulkReject(form.getAll("ids").map(String), field(form, "reason")), "bulk_rejected");
}

export async function restoreAction(form: FormData) {
  const id = field(form, "id");
  done(form, await restoreArticle(id), id, "restored");
}

export async function bulkRestoreAction(form: FormData) {
  if (!confirmed(form)) back(form, bannerParams({ error: "needs_confirmation" }));
  bulkDone(form, await bulkRestore(form.getAll("ids").map(String)), "bulk_restored");
}

/** A department id from the form, or null for "keep each item's own guess". */
const departmentField = (form: FormData) => field(form, "department_id") || null;

export async function markRelevantAction(form: FormData) {
  const id = field(form, "id");
  done(form, await markRelevant(id, departmentField(form)), id, "marked_relevant");
}

export async function bulkMarkRelevantAction(form: FormData) {
  if (!confirmed(form)) back(form, bannerParams({ error: "needs_confirmation" }));
  bulkDone(form, await bulkMarkRelevant(form.getAll("ids").map(String), departmentField(form)), "bulk_marked");
}

/** Why a stage ended before its queue was empty, when it was not an error. */
export type StageStopped = "rate_limited" | "provider_error" | "time_budget" | "budget_exceeded" | null;
const STOPS = new Set(["rate_limited", "provider_error", "time_budget", "budget_exceeded"]);
const stoppedOf = (v: unknown): StageStopped => (typeof v === "string" && STOPS.has(v) ? (v as StageStopped) : null);

export type StageStep =
  | { ok: true; stage: string; error?: string; processed: number; remaining: number; rateLimited: boolean; rejected: number; failed: number; stopped: StageStopped; stoppedError: string | null }
  | { ok: false; error: string };

/** One stage, one chunk, for the progress button. Called from the browser, so it re-checks the admin itself. */
export async function runStageAction(stage: string): Promise<StageStep> {
  if (!isStageName(stage)) return { ok: false, error: "Unknown stage." };
  const result = await runOneStage(stage);
  if (!result.ok) return result;
  const { outcome } = result;
  if (!outcome.ok) return { ok: false, error: `${stage} failed: ${outcome.error}` };
  const s = (outcome.summary ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  revalidatePath("/admin/review");
  return {
    ok: true,
    stage,
    processed: n(s.processed),
    remaining: n(s.remaining),
    rateLimited: s.rateLimited === true,
    rejected: n(s.rejected),
    failed: n(s.failed),
    stopped: stoppedOf(s.stopped),
    stoppedError: typeof s.stoppedError === "string" && s.stoppedError ? s.stoppedError : null,
  };
}

/** "Raise today's limit" (admin only, checked inside raiseTodaysLimit): lifts the daily AI spend cap until midnight IST. Logged. */
export async function raiseBudgetAction(form: FormData) {
  const result = await raiseTodaysLimit(field(form, "limit"));
  if (!result.ok) fail(form, result.error);
  back(form, bannerParams({ notice: "budget_raised" }));
}

/** Ends the session: Supabase sign-out (clears the auth cookies), the activity marker, then the login page. */
export async function signOutAction() {
  try {
    await (await supabaseServer()).auth.signOut();
  } catch (err) {
    console.error(`sign out failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  (await cookies()).delete(ADMIN_ACTIVITY_COOKIE);
  redirect("/admin/login");
}
