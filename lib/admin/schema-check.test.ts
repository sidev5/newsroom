import { describe, expect, it } from "vitest";
import { PUBLIC_ARTICLE_GRANTED_COLUMNS } from "@/lib/news/public-columns";
import { checkSchema, REQUIRED_BUCKETS, REQUIRED_COLUMNS, REQUIRED_TABLES, GRANT_MIGRATION, RELIABILITY_MIGRATION, SUBMISSIONS_MIGRATION, SUMMARY_MIGRATION, type ProbeError, type SchemaProbe } from "./schema-check";

// The setup check (GET /api/cron/health): it must name every missing table, column, bucket and seed row,
// and the file that fixes it. The database is replaced by a fake that knows what exists.

type World = {
  /** table -> columns it has. A table that is not listed does not exist. */
  tables: Record<string, string[]>;
  buckets?: Record<string, boolean>; // id -> public
  departments?: string[];
  /** Columns of articles the PUBLIC key may read. */
  anonReadable?: string[];
  fail?: { table?: string; bucket?: string };
};

const missingTable = (t: string): ProbeError => ({ code: "42P01", message: `relation "public.${t}" does not exist` });
const missingColumn = (t: string, c: string): ProbeError => ({ code: "42703", message: `column ${t}.${c} does not exist` });

function probe(w: World): SchemaProbe {
  return {
    async table(table) {
      if (w.fail?.table === table) return { error: { code: "XX000", message: "connection reset" }, count: null };
      return table in w.tables ? { error: null, count: 3 } : { error: missingTable(table), count: null };
    },
    async columns(table, columns) {
      const have = w.tables[table] ?? [];
      const missing = columns.find((c) => !have.includes(c));
      return { error: missing ? missingColumn(table, missing) : null }; // like PostgREST: only the first one is named
    },
    async bucket(id) {
      if (w.fail?.bucket === id) return { error: { message: "storage unreachable" }, found: false, isPublic: false };
      const b = w.buckets ?? {};
      return { error: null, found: id in b, isPublic: b[id] ?? false };
    },
    async anonArticleColumns(columns) {
      const ok = w.anonReadable ?? [];
      const denied = columns.find((c) => !ok.includes(c));
      return { error: denied ? { code: "42501", message: "permission denied for table articles" } : null };
    },
    async department(slug) {
      return { error: null, found: (w.departments ?? []).includes(slug) };
    },
  };
}

/** A database that has everything the code needs. */
function complete(): World {
  const tables: Record<string, string[]> = Object.fromEntries(REQUIRED_TABLES.map((t) => [t.table, [] as string[]]));
  for (const c of REQUIRED_COLUMNS) tables[c.table] = [...(tables[c.table] ?? []), ...c.columns]; // a table can have several entries
  return {
    tables,
    buckets: Object.fromEntries(REQUIRED_BUCKETS.map((b) => [b.id, b.public])),
    departments: ["ai-technology"],
    anonReadable: [...PUBLIC_ARTICLE_GRANTED_COLUMNS],
  };
}

describe("checkSchema", () => {
  it("passes when everything is there", async () => {
    const r = await checkSchema(probe(complete()));
    expect(r).toMatchObject({ ok: true, failed: false, missingTables: [], missingColumns: [], bucketProblems: [], missingRows: [] });
    expect(r.message).toBeUndefined();
    expect(Object.keys(r.counts)).toEqual(REQUIRED_TABLES.map((t) => t.table));
    expect(r.counts.article_submitters).toBe(3);
  });

  it("covers the new table, the new article columns and both buckets", () => {
    expect(REQUIRED_TABLES.map((t) => t.table)).toContain("article_submitters");
    expect(REQUIRED_COLUMNS.find((c) => c.table === "articles")!.columns).toEqual(
      expect.arrayContaining(["origin", "author_first_name", "author_last_name", "author_department"]),
    );
    expect(REQUIRED_COLUMNS.find((c) => c.table === "article_submitters")!.columns).toEqual(
      expect.arrayContaining(["article_id", "email", "ip_hash", "email_verified", "submitted_at", "image_path"]),
    );
    expect(REQUIRED_BUCKETS).toEqual([
      { id: "submission-images", public: false },
      { id: "article-images", public: true },
    ]);
  });

  it("names every missing column, not only the first one PostgREST reports", async () => {
    const w = complete();
    w.tables.articles = w.tables.articles.filter((c) => !["origin", "author_first_name", "author_department"].includes(c));
    const r = await checkSchema(probe(w));
    expect(r.ok).toBe(false);
    expect(r.missingColumns.map((m) => `${m.table}.${m.column}`)).toEqual(["articles.origin", "articles.author_first_name", "articles.author_department"]);
    expect(r.message).toBe(
      `Missing columns: articles.origin, articles.author_first_name, articles.author_department. Run ${SUBMISSIONS_MIGRATION} in the Supabase SQL editor.`,
    );
  });

  it("a database without articles.summary is told to run the 2026-10-18 file (the homepage list needs it)", async () => {
    const w = complete();
    w.tables.articles = w.tables.articles.filter((c) => c !== "summary");
    const r = await checkSchema(probe(w));
    expect(r.ok).toBe(false);
    expect(r.missingColumns).toEqual([{ table: "articles", column: "summary", run: SUMMARY_MIGRATION }]);
    expect(r.message).toBe(`Missing columns: articles.summary. Run ${SUMMARY_MIGRATION} in the Supabase SQL editor.`);
    expect(SUMMARY_MIGRATION).toContain("2026-10-18_article_summary.sql");
  });

  it("a database without the 2026-10-19 reliability migration is told to run it (no stage lock, no limit raises)", async () => {
    const w = complete();
    delete w.tables.budget_overrides;
    w.tables.pipeline_runs = w.tables.pipeline_runs.filter((c) => c !== "alert_sent");
    const r = await checkSchema(probe(w));
    expect(r.ok).toBe(false);
    expect(r.missingTables).toEqual([{ table: "budget_overrides", run: RELIABILITY_MIGRATION }]);
    expect(r.missingColumns).toEqual([{ table: "pipeline_runs", column: "alert_sent", run: RELIABILITY_MIGRATION }]);
    expect(r.message).toContain(RELIABILITY_MIGRATION);
    expect(RELIABILITY_MIGRATION).toContain("2026-10-19_reliability.sql");
  });
  it("the grant problems point at the file whose grant is the current one", () => {
    expect(GRANT_MIGRATION).toContain("2026-10-22_story_blocks.sql");
  });

  it("reports a missing table with the file that creates it, and does not also report its columns", async () => {
    const w = complete();
    delete w.tables.article_submitters;
    const r = await checkSchema(probe(w));
    expect(r.missingTables).toEqual([{ table: "article_submitters", run: SUBMISSIONS_MIGRATION }]);
    expect(r.missingColumns).toEqual([]);
    expect(r.counts.article_submitters).toBe(`missing: run ${SUBMISSIONS_MIGRATION}`);
    expect(r.message).toContain("Missing tables: article_submitters.");
  });

  it("catches columns missing from the digest tables, the cause of 'column not found' errors", async () => {
    const w = complete();
    w.tables.digests = w.tables.digests.filter((c) => c !== "reminder_sent_at");
    const r = await checkSchema(probe(w));
    expect(r.missingColumns).toEqual([{ table: "digests", column: "reminder_sent_at", run: "supabase/migrations/2026-10-16_weekly_digest.sql" }]);
    expect(r.message).toContain("2026-10-16_weekly_digest.sql");
  });

  it("flags a missing or wrongly public/private bucket", async () => {
    const w = complete();
    delete w.buckets!["article-images"];
    w.buckets!["submission-images"] = true; // private photos must not be public
    const r = await checkSchema(probe(w));
    expect(r.ok).toBe(false);
    expect(r.bucketProblems).toEqual(["submission-images: is public but must be private", "article-images: missing"]);
    expect(r.message).toContain("Storage buckets:");
    expect(r.message).toContain(SUBMISSIONS_MIGRATION);
  });

  it("flags the missing AI & Technology department row", async () => {
    const w = complete();
    w.departments = [];
    const r = await checkSchema(probe(w));
    expect(r.missingRows).toEqual(['department "AI & Technology" (ai-technology)']);
    expect(r.ok).toBe(false);
  });

  it("flags an internal article column the public key can read (SEC-02)", async () => {
    const w = complete();
    w.anonReadable = [...PUBLIC_ARTICLE_GRANTED_COLUMNS, "review_note", "fact_check_notes"];
    const r = await checkSchema(probe(w));
    expect(r.ok).toBe(false);
    expect(r.grantProblems).toEqual(["the public key can read articles.fact_check_notes", "the public key can read articles.review_note"]);
    expect(r.message).toBe(`Public access to articles: the public key can read articles.fact_check_notes; the public key can read articles.review_note. Run ${GRANT_MIGRATION} in the Supabase SQL editor.`);
  });

  it("flags a database where the public key can read everything (grants never applied)", async () => {
    const w = complete();
    w.anonReadable = [...PUBLIC_ARTICLE_GRANTED_COLUMNS, "fact_check_notes", "review_note", "image_query", "raw_item_id", "created_at", "reviewed_by", "reviewed_at", "previous_status"];
    const r = await checkSchema(probe(w));
    expect(r.grantProblems).toHaveLength(8);
  });

  it("flags a public key that can no longer read the public columns (the website would be empty)", async () => {
    const w = complete();
    w.anonReadable = [];
    const r = await checkSchema(probe(w));
    expect(r.grantProblems[0]).toMatch(/cannot read the public columns of articles/);
    expect(r.ok).toBe(false);
  });

  it("treats an unexpected database error as a failure, not as a missing table", async () => {
    const r = await checkSchema(probe({ ...complete(), fail: { table: "articles" } }));
    expect(r.failed).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.missingTables).toEqual([]);
    expect(r.counts.articles).toBe("error: connection reset");
  });

  it("treats an unreachable storage service as a failure", async () => {
    const r = await checkSchema(probe({ ...complete(), fail: { bucket: "article-images" } }));
    expect(r.failed).toBe(true);
    expect(r.bucketProblems[0]).toContain("could not be checked");
  });

  it("combines several problems into one message with each file named once", async () => {
    const w = complete();
    delete w.tables.digest_log;
    delete w.buckets!["article-images"];
    const r = await checkSchema(probe(w));
    expect(r.message).toBe(
      `Missing tables: digest_log. Storage buckets: article-images: missing. Run supabase/migrations/2026-10-16_weekly_digest.sql and ${SUBMISSIONS_MIGRATION} in the Supabase SQL editor.`,
    );
  });
});
