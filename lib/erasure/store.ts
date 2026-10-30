import "server-only";
import { STORAGE_BUCKETS } from "@/lib/config";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isMissingColumn, isMissingTable } from "@/lib/supabase/errors";
import type { EraseStore, PersonArticle } from "./erase";

type Row = {
  article_id: string;
  image_path: string | null;
  image_paths?: string[] | null;
  submitted_at: string | null;
  articles: {
    headline: string;
    status: string;
    origin: "ai" | "employee";
    image_url: string | null;
    departments: { slug: string } | { slug: string }[] | null;
  } | null;
};

const first = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

/** The service-role implementation. The caller (lib/erasure/runtime.ts) has checked the admin. */
export function supabaseEraseStore(): EraseStore {
  const db = () => supabaseAdmin();
  return {
    async submissionsOf(email) {
      // image_paths (the images of a Write story) exists after 2026-10-22_story_blocks.sql: until then the older list is asked for.
      const tail = "articles(headline, status, origin, image_url, departments(slug))";
      const ask = (columns: string) => db().from("article_submitters").select(columns).eq("email", email);
      let { data, error } = await ask(`article_id, image_path, image_paths, submitted_at, ${tail}`);
      if (error && isMissingColumn(error)) ({ data, error } = await ask(`article_id, image_path, submitted_at, ${tail}`));
      if (error) throw new Error(`Loading the submissions failed: ${error.message}`);
      return ((data ?? []) as unknown as Row[]).flatMap((r): PersonArticle[] => {
        const a = first(r.articles);
        if (!a) return [];
        return [
          {
            id: r.article_id,
            headline: a.headline,
            status: a.status,
            origin: a.origin,
            image_url: a.image_url,
            image_path: r.image_path,
            image_paths: r.image_paths ?? [],
            departmentSlug: first(a.departments)?.slug ?? null,
            submittedAt: r.submitted_at,
          },
        ];
      });
    },

    async recipientsOf(email) {
      const { data, error } = await db().from("digest_recipients").select("id").eq("email", email);
      if (error) throw new Error(`Loading the digest recipients failed: ${error.message}`);
      return ((data ?? []) as { id: string }[]).map((r) => r.id);
    },

    async readerDataOf(userKey) {
      const count = async (table: "article_likes" | "article_comments") => {
        const { count: n, error } = await db().from(table).select("user_key", { count: "exact", head: true }).eq("user_key", userKey);
        // Before 2026-10-22_story_blocks.sql these tables do not exist: there is nothing to find.
        if (error) {
          if (isMissingTable(error)) return 0;
          throw new Error(`Loading the reader data failed: ${error.message}`);
        }
        return n ?? 0;
      };
      const [likes, comments] = await Promise.all([count("article_likes"), count("article_comments")]);
      return { likes, comments };
    },

    async deleteReaderData(userKey) {
      const del = async (table: string, column: string, key: string, select: string) => {
        const { data, error } = await db().from(table).delete().eq(column, key).select(select);
        if (error) throw new Error(`Removing the reader data failed: ${error.message}`);
        return data?.length ?? 0;
      };
      const likes = await del("article_likes", "user_key", userKey, "user_key");
      const comments = await del("article_comments", "user_key", userKey, "id");
      await del("reader_login_codes", "email_key", userKey, "id");
      await del("reader_events", "user_key", userKey, "id");
      return { likes, comments };
    },

    async removePhotos(bucket, paths) {
      const name = bucket === "private" ? STORAGE_BUCKETS.submissions : STORAGE_BUCKETS.published;
      let failed = 0;
      for (let i = 0; i < paths.length; i += 100) {
        const batch = paths.slice(i, i + 100);
        const { error } = await db().storage.from(name).remove(batch);
        if (error) failed += batch.length;
      }
      return { failed };
    },

    async updateArticle(id, patch) {
      const { error } = await db().from("articles").update(patch).eq("id", id);
      if (error) throw new Error(`Updating a story failed: ${error.message}`);
    },

    async deleteRecipients(ids) {
      const { data, error } = await db().from("digest_recipients").delete().in("id", ids).select("id");
      if (error) throw new Error(`Removing the digest recipient failed: ${error.message}`);
      return data?.length ?? 0;
    },

    async deleteSubmitters(articleIds) {
      const { data, error } = await db().from("article_submitters").delete().in("article_id", articleIds).select("article_id");
      if (error) throw new Error(`Removing the submitter details failed: ${error.message}`);
      return data?.length ?? 0;
    },

    async log(entry) {
      const { error } = await db().from("privacy_log").insert(entry);
      if (error) throw new Error(error.message);
    },
  };
}

export type PrivacyLogRow = { created_at: string; admin_email: string; action: string; detail: Record<string, unknown> | null };

/** The latest entries of the erasure log, for the admin page. They hold no address. */
export async function recentErasures(limit = 20): Promise<PrivacyLogRow[]> {
  const { data, error } = await supabaseAdmin().from("privacy_log").select("created_at, admin_email, action, detail").order("created_at", { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as PrivacyLogRow[];
}
