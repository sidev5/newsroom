import "server-only";
import { currentAdminEmail } from "@/lib/admin/session";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { AdminComment, CommentStatus, ModerationDeps } from "./moderation";

/** The real dependencies of the comment moderation. Everything here uses the service role: the callers check the admin first. */
export function moderationDeps(): ModerationDeps {
  return {
    adminEmail: currentAdminEmail,
    async setStatus(id, status: CommentStatus) {
      const { data, error } = await supabaseAdmin().from("article_comments").update({ status }).eq("id", id).select("article_id");
      if (error) throw new Error(error.message);
      const row = (data ?? [])[0] as { article_id: string } | undefined;
      return row ? { articleId: row.article_id } : null;
    },
    async log(entry) {
      const { error } = await supabaseAdmin().from("comment_log").insert(entry);
      if (error) throw new Error(error.message);
    },
    now: () => new Date(),
  };
}

/** All comments (hidden ones too) of these articles, newest first. Admin only: the page checked before calling. Empty before the migration. */
export async function loadCommentsFor(articleIds: string[]): Promise<Map<string, AdminComment[]>> {
  const out = new Map<string, AdminComment[]>();
  if (articleIds.length === 0) return out;
  const { data, error } = await supabaseAdmin()
    .from("article_comments")
    .select("id, article_id, display_name, body, status, created_at")
    .in("article_id", articleIds)
    .order("created_at", { ascending: false });
  if (error) return out;
  for (const r of (data ?? []) as { id: string; article_id: string; display_name: string; body: string; status: CommentStatus; created_at: string }[]) {
    const list = out.get(r.article_id) ?? [];
    list.push({ id: r.id, articleId: r.article_id, name: r.display_name, body: r.body, status: r.status, createdAt: r.created_at });
    out.set(r.article_id, list);
  }
  return out;
}