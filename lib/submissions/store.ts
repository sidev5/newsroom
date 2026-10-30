import "server-only";
import { STORAGE_BUCKETS } from "@/lib/config";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { SubmissionStore } from "./service";

// The service-role implementation of the submission store. It is only reached from the server action
// after validation, and it is the only way the public form writes anything: there is no public insert policy.

type DbError = { message: string } | null;
function check(error: DbError, what: string): void {
  if (error) throw new Error(`${what} failed: ${error.message}`);
}

export function supabaseSubmissionStore(): SubmissionStore {
  const db = () => supabaseAdmin();

  return {
    async sectors() {
      const { data, error } = await db().from("departments").select("id, slug, name").eq("kind", "company").order("name");
      check(error, "Loading departments");
      return (data ?? []) as { id: string; slug: string; name: string }[];
    },

    async counts({ ipHash, email, sinceIso }) {
      const count = async (column: "ip_hash" | "email", value: string) => {
        const { count: n, error } = await db()
          .from("article_submitters")
          .select("article_id", { count: "exact", head: true })
          .eq(column, value)
          .gte("submitted_at", sinceIso);
        check(error, "Counting submissions");
        return n ?? 0;
      };
      const [ip, byEmail] = await Promise.all([ipHash ? count("ip_hash", ipHash) : Promise.resolve(null), count("email", email)]);
      return { ip, email: byEmail };
    },

    async recentTitles(email, sinceIso) {
      const { data, error } = await db().from("article_submitters").select("articles(headline)").eq("email", email).gte("submitted_at", sinceIso);
      check(error, "Loading recent submissions");
      type Row = { articles: { headline: string } | { headline: string }[] | null };
      return ((data ?? []) as unknown as Row[])
        .map((r) => (Array.isArray(r.articles) ? r.articles[0] : r.articles)?.headline)
        .filter((h): h is string => typeof h === "string");
    },

    async uploadPhoto(path, data, contentType) {
      const { error } = await db().storage.from(STORAGE_BUCKETS.submissions).upload(path, data, { contentType, upsert: false });
      check(error, "Uploading the photo");
    },

    async removePhoto(path) {
      await db().storage.from(STORAGE_BUCKETS.submissions).remove([path]);
    },

    async insert(article, submitter) {
      const { data, error } = await db().from("articles").insert(article).select("id").single();
      check(error, "Saving the story");
      const id = (data as { id: string }).id;
      const { error: submitterError } = await db().from("article_submitters").insert({ article_id: id, ...submitter });
      if (submitterError) {
        // Without its submitter row the story could never be traced or rate-limited: remove it.
        await db().from("articles").delete().eq("id", id);
        check(submitterError, "Saving the author details");
      }
      return { id };
    },
  };
}
