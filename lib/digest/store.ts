import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isMissingTable } from "@/lib/supabase/errors";
import type { Recipient, RecipientStore } from "./recipients";
import type { DigestStore, NewDigest } from "./service";
import type { DigestArticle, DigestRow, DigestStatus } from "./types";

export const MISSING_TABLES_MESSAGE =
  "The digest tables are missing. Run supabase/migrations/2026-10-16_weekly_digest.sql in the Supabase SQL editor, then reload.";

/** Thrown when a digest table does not exist yet, so pages and cron routes can say so instead of failing with a 500. */
export class DigestSchemaError extends Error {
  constructor() {
    super(MISSING_TABLES_MESSAGE);
    this.name = "DigestSchemaError";
  }
}

export { isMissingTable };

type DbError = { code?: string; message: string };
function check(error: DbError | null, what: string): void {
  if (!error) return;
  if (isMissingTable(error)) throw new DigestSchemaError();
  throw new Error(`${what} failed: ${error.message}`);
}

const ARTICLE_COLUMNS =
  "id, slug, headline, body, country_name, image_url, image_alt, image_credit, image_credit_url, source_urls, source_published_at, published_at, origin, author_first_name, author_last_name, author_department, departments(name, slug)";

type ArticleRow = Omit<DigestArticle, "department"> & { departments: { name: string; slug: string } | { name: string; slug: string }[] | null };

function toArticle({ departments, ...rest }: ArticleRow): DigestArticle {
  return {
    ...rest,
    // Department default images are relative SVG paths: no use in an email, so they count as "no photo".
    image_url: rest.image_url && /^https:\/\//i.test(rest.image_url) ? rest.image_url : null,
    department: (Array.isArray(departments) ? departments[0] : departments) ?? null,
  };
}

export function supabaseDigestStore(): DigestStore {
  const db = () => supabaseAdmin();

  return {
    async getByWeek(week) {
      const { data, error } = await db().from("digests").select("*").eq("week_start", week).maybeSingle();
      check(error, "Loading the digest");
      return (data as DigestRow | null) ?? null;
    },
    async getById(id) {
      const { data, error } = await db().from("digests").select("*").eq("id", id).maybeSingle();
      check(error, "Loading the digest");
      return (data as DigestRow | null) ?? null;
    },
    async current(week) {
      const { data, error } = await db().from("digests").select("*").lte("week_start", week).order("week_start", { ascending: false }).limit(1);
      check(error, "Loading the digest");
      return ((data ?? [])[0] as DigestRow | undefined) ?? null;
    },
    async insertIfAbsent(row: NewDigest) {
      // The unique week_start decides: a concurrent insert leaves this one empty.
      const { data, error } = await db().from("digests").upsert(row, { onConflict: "week_start", ignoreDuplicates: true }).select();
      check(error, "Saving the digest");
      return ((data ?? [])[0] as DigestRow | undefined) ?? null;
    },
    async update(id, patch, from: DigestStatus[], opts) {
      let q = db().from("digests").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).in("status", from);
      if (opts?.reminderUnsent) q = q.is("reminder_sent_at", null);
      const { data, error } = await q.select();
      check(error, "Updating the digest");
      return ((data ?? [])[0] as DigestRow | undefined) ?? null;
    },
    async usedArticleIds(beforeWeek) {
      const { data, error } = await db().from("digests").select("article_ids").lt("week_start", beforeWeek).in("status", ["approved", "sending", "sent"]);
      check(error, "Loading earlier digests");
      return new Set(((data ?? []) as { article_ids: string[] }[]).flatMap((d) => d.article_ids ?? []));
    },
    async candidates(sinceIso) {
      const { data, error } = await db()
        .from("articles")
        .select(ARTICLE_COLUMNS)
        .eq("status", "published")
        .gte("published_at", sinceIso)
        .order("published_at", { ascending: false })
        .limit(100);
      check(error, "Loading stories");
      return ((data ?? []) as unknown as ArticleRow[]).map(toArticle);
    },
    async articles(ids) {
      if (ids.length === 0) return [];
      const { data, error } = await db().from("articles").select(ARTICLE_COLUMNS).eq("status", "published").in("id", ids);
      check(error, "Loading stories");
      const byId = new Map(((data ?? []) as unknown as ArticleRow[]).map((r) => [r.id, toArticle(r)]));
      return ids.map((id) => byId.get(id)).filter((a): a is DigestArticle => Boolean(a));
    },
    async activeRecipients() {
      const { data, error } = await db().from("digest_recipients").select("email").eq("active", true).order("created_at");
      check(error, "Loading recipients");
      return ((data ?? []) as { email: string }[]).map((r) => r.email);
    },
    async log(digestId, action, actor, detail) {
      const { error } = await db().from("digest_log").insert({ digest_id: digestId, action, actor, detail: detail ?? null });
      check(error, "Writing the digest log");
    },
    async lastFailure(digestId) {
      const { data, error } = await db()
        .from("digest_log")
        .select("created_at, detail")
        .eq("digest_id", digestId)
        .eq("action", "send_failed")
        .order("created_at", { ascending: false })
        .limit(1);
      check(error, "Loading the digest log");
      const row = (data ?? [])[0] as { created_at: string; detail: { error?: string } | null } | undefined;
      return row ? { at: row.created_at, error: String(row.detail?.error ?? "").slice(0, 300) } : null;
    },
  };
}

export function supabaseRecipientStore(): RecipientStore {
  const db = () => supabaseAdmin();
  return {
    async list(): Promise<Recipient[]> {
      const { data, error } = await db().from("digest_recipients").select("id, email, active").order("email");
      check(error, "Loading recipients");
      return (data ?? []) as Recipient[];
    },
    async add(emails) {
      const { data, error } = await db().from("digest_recipients").upsert(emails.map((email) => ({ email })), { onConflict: "email", ignoreDuplicates: true }).select("id");
      check(error, "Adding recipients");
      return data?.length ?? 0;
    },
    async remove(id) {
      const { data, error } = await db().from("digest_recipients").delete().eq("id", id).select("id");
      check(error, "Removing the recipient");
      return (data?.length ?? 0) > 0;
    },
    async setActive(id, active) {
      const { data, error } = await db().from("digest_recipients").update({ active }).eq("id", id).select("id");
      check(error, "Updating the recipient");
      return (data?.length ?? 0) > 0;
    },
  };
}
