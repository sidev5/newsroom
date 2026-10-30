import { NOT_AUTHORISED } from "@/lib/admin/messages";

// Hiding a comment (and showing it again). Admin only, checked first; every change is written to comment_log with who did it.
// With the effects injected, so the rules are tested without a database.

export type CommentStatus = "visible" | "hidden";

export type AdminComment = { id: string; articleId: string; name: string; body: string; status: CommentStatus; createdAt: string };

export type ModerationDeps = {
  /** The admin's email, or null when the caller is not a signed-in admin. */
  adminEmail: () => Promise<string | null>;
  /** Service-role write. Resolves to the article of the comment, or null when there is no such comment. */
  setStatus: (id: string, status: CommentStatus) => Promise<{ articleId: string } | null>;
  log: (entry: { comment_id: string; article_id: string; action: "hide" | "unhide"; actor_email: string; reason: string | null; created_at: string }) => Promise<void>;
  now: () => Date;
};

export type ModerationResult = { ok: true; warning?: string } | { ok: false; error: string };

const GONE = "That comment no longer exists.";
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON = 500;

async function setStatus(deps: ModerationDeps, id: string, status: CommentStatus, reason: unknown): Promise<ModerationResult> {
  // 1. The admin check comes first: the service role is not touched for anyone else.
  const admin = await deps.adminEmail();
  if (!admin) return { ok: false, error: NOT_AUTHORISED };
  if (typeof id !== "string" || !ID.test(id)) return { ok: false, error: GONE };

  let found: { articleId: string } | null;
  try {
    found = await deps.setStatus(id, status);
  } catch (err) {
    return { ok: false, error: `Update failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!found) return { ok: false, error: GONE };

  try {
    await deps.log({
      comment_id: id,
      article_id: found.articleId,
      action: status === "hidden" ? "hide" : "unhide",
      actor_email: admin,
      reason: typeof reason === "string" && reason.trim() ? reason.trim().slice(0, MAX_REASON) : null,
      created_at: deps.now().toISOString(),
    });
  } catch (err) {
    // The change itself has been made; say so rather than pretend it failed.
    return { ok: true, warning: `The change was saved but the audit log entry failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true };
}

export const hideComment = (deps: ModerationDeps, id: string, reason?: unknown) => setStatus(deps, id, "hidden", reason);
export const unhideComment = (deps: ModerationDeps, id: string, reason?: unknown) => setStatus(deps, id, "visible", reason);