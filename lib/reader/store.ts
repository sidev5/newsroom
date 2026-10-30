import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabasePublic } from "@/lib/supabase/public";
import type { AuthStore, CodeRow } from "./auth";
import type { EngagementStore, PublicComment } from "./engagement";

// The database side of lib/reader/auth.ts and lib/reader/engagement.ts. What the public may read goes through the public key
// (so the row-level security of the database is what limits it: visible comments of published articles, like counts from the
// view); everything that writes, and everything that depends on who the reader is, uses the service role from server routes.

type DbError = { message: string } | null;
function check(error: DbError, what: string): void {
  if (error) throw new Error(`${what} failed: ${error.message}`);
}

export function supabaseAuthStore(): AuthStore {
  const db = () => supabaseAdmin();
  return {
    async countCodes({ emailKey, ipHash, sinceIso }) {
      const one = async (column: "email_key" | "ip_hash", value: string) => {
        const { count, error } = await db().from("reader_login_codes").select("id", { count: "exact", head: true }).eq(column, value).gte("created_at", sinceIso);
        check(error, "Counting codes");
        return count ?? 0;
      };
      const [email, ip] = await Promise.all([one("email_key", emailKey), ipHash ? one("ip_hash", ipHash) : Promise.resolve(null)]);
      return { email, ip };
    },
    async insertCode({ emailKey, codeHash, ipHash, expiresAtIso }) {
      const { error } = await db().from("reader_login_codes").insert({ email_key: emailKey, code_hash: codeHash, ip_hash: ipHash, expires_at: expiresAtIso });
      check(error, "Saving the code");
    },
    async latestCode(emailKey) {
      const { data, error } = await db()
        .from("reader_login_codes")
        .select("id, code_hash, attempts, expires_at, used_at")
        .eq("email_key", emailKey)
        .order("created_at", { ascending: false })
        .limit(1);
      check(error, "Loading the code");
      return ((data ?? [])[0] as CodeRow | undefined) ?? null;
    },
    async registerAttempt(id, max) {
      const { data, error } = await db().rpc("reader_code_attempt", { p_id: id, p_max: max });
      check(error, "Counting the try");
      return typeof data === "number" ? data : null;
    },
    async markUsed(id, nowIso) {
      const { data, error } = await db().from("reader_login_codes").update({ used_at: nowIso }).eq("id", id).is("used_at", null).select("id");
      check(error, "Using the code");
      return (data?.length ?? 0) > 0;
    },
    async prune(beforeIso) {
      const { error } = await db().from("reader_login_codes").delete().lt("expires_at", beforeIso);
      check(error, "Pruning codes");
      const events = await db().from("reader_events").delete().lt("created_at", beforeIso);
      check(events.error, "Pruning events");
    },
  };
}

type CommentRow = { id: string; display_name: string; body: string; created_at: string };
const toComment = (r: CommentRow): PublicComment => ({ id: r.id, name: r.display_name, body: r.body, createdAt: r.created_at });

export function supabaseEngagementStore(): EngagementStore {
  const db = () => supabaseAdmin();
  return {
    async article(slug) {
      // The public key: only a published article is visible to it.
      const { data, error } = await supabasePublic().from("articles").select("id, body_format, origin").eq("status", "published").eq("slug", slug).maybeSingle();
      check(error, "Loading the story");
      const row = data as { id: string; body_format: string; origin: string } | null;
      // Likes and comments are for stories written by employees with Write: an AI-written blocks story is "plain" here.
      return row ? { id: row.id, format: row.body_format === "blocks" && row.origin === "employee" ? "blocks" : "plain" } : null;
    },
    async likeCount(articleId) {
      const { data, error } = await supabasePublic().from("article_like_counts").select("likes").eq("article_id", articleId).maybeSingle();
      check(error, "Counting likes");
      return (data as { likes: number } | null)?.likes ?? 0;
    },
    async hasLiked(articleId, userKey) {
      const { count, error } = await db().from("article_likes").select("article_id", { count: "exact", head: true }).eq("article_id", articleId).eq("user_key", userKey);
      check(error, "Reading the like");
      return (count ?? 0) > 0;
    },
    async addLike(articleId, userKey) {
      // The primary key (article_id, user_key) makes a double click harmless.
      const { error } = await db().from("article_likes").upsert({ article_id: articleId, user_key: userKey }, { onConflict: "article_id,user_key", ignoreDuplicates: true });
      check(error, "Saving the like");
    },
    async removeLike(articleId, userKey) {
      const { error } = await db().from("article_likes").delete().eq("article_id", articleId).eq("user_key", userKey);
      check(error, "Removing the like");
    },
    async likeToggles(userKey, sinceIso) {
      const { count, error } = await db().from("reader_events").select("id", { count: "exact", head: true }).eq("user_key", userKey).eq("kind", "like").gte("created_at", sinceIso);
      check(error, "Counting likes");
      return count ?? 0;
    },
    async logLikeToggle(userKey) {
      const { error } = await db().from("reader_events").insert({ user_key: userKey, kind: "like" });
      check(error, "Logging the like");
    },
    async comments(articleId, limit) {
      const { data, error } = await supabasePublic()
        .from("article_comments")
        .select("id, display_name, body, created_at")
        .eq("article_id", articleId)
        .eq("status", "visible")
        .order("created_at", { ascending: false })
        .limit(limit);
      check(error, "Loading comments");
      return ((data ?? []) as CommentRow[]).map(toComment);
    },
    async commentCount(userKey, sinceIso) {
      const { count, error } = await db().from("article_comments").select("id", { count: "exact", head: true }).eq("user_key", userKey).gte("created_at", sinceIso);
      check(error, "Counting comments");
      return count ?? 0;
    },
    async recentCommentBodies(userKey, sinceIso) {
      const { data, error } = await db().from("article_comments").select("body").eq("user_key", userKey).gte("created_at", sinceIso).order("created_at", { ascending: false }).limit(30);
      check(error, "Loading recent comments");
      return ((data ?? []) as { body: string }[]).map((r) => r.body);
    },
    async addComment({ articleId, userKey, displayName, body }) {
      const { data, error } = await db()
        .from("article_comments")
        .insert({ article_id: articleId, user_key: userKey, display_name: displayName, body })
        .select("id, display_name, body, created_at")
        .single();
      check(error, "Saving the comment");
      return toComment(data as CommentRow);
    },
  };
}
