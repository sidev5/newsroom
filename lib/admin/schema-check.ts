import { STORAGE_BUCKETS } from "@/lib/config";
import { INTERNAL_ARTICLE_COLUMNS, PUBLIC_ARTICLE_GRANTED_COLUMNS } from "@/lib/news/public-columns";
import { isMissingColumn, isMissingTable } from "@/lib/supabase/errors";

// The setup check behind GET /api/cron/health: which tables, columns, storage buckets and seed rows the
// code needs, and which of them the database does not have yet. The database is reached through a small
// probe interface, so the rules can be tested without one.

export type ProbeError = { code?: string; message: string } | null;

export interface SchemaProbe {
  /** Row count of the table (a head request). */
  table(table: string): Promise<{ error: ProbeError; count: number | null }>;
  /** Selects the given columns with no rows. An error means at least one of them is missing. */
  columns(table: string, columns: string[]): Promise<{ error: ProbeError }>;
  bucket(id: string): Promise<{ error: ProbeError; found: boolean; isPublic: boolean }>;
  /** Selects the given columns of `articles` with the PUBLIC (anon) key and no rows. An error means the anon role may not read one of them. */
  anonArticleColumns(columns: string[]): Promise<{ error: ProbeError }>;
  department(slug: string): Promise<{ error: ProbeError; found: boolean }>;
}

const SCHEMA = "supabase/schema.sql";
const WORLD = "supabase/migrations/2026-10-14_world_review_pipeline.sql";
const DIGEST = "supabase/migrations/2026-10-16_weekly_digest.sql";
export const SUBMISSIONS_MIGRATION = "supabase/migrations/2026-10-15-ai-tech-and-submissions.sql";
export const SUMMARY_MIGRATION = "supabase/migrations/2026-10-18_article_summary.sql";
/**
 * The file to run when the public column grant on articles is wrong. 2026-10-17 created the grant; 2026-10-18 replaced it with
 * the list with `summary`; 2026-10-22 replaced it again (it adds `body_blocks` and `body_format`), so running the newest one always leaves the right grant.
 */
export const GRANT_MIGRATION = "supabase/migrations/2026-10-22_story_blocks.sql";
/** The stage lock and failure alerts (pipeline_runs), the daily-limit raises (budget_overrides) and the retention function. */
export const RELIABILITY_MIGRATION = "supabase/migrations/2026-10-19_reliability.sql";

/** The Write page: block stories, likes, comments and the reader sign-in codes. */
export const STORY_BLOCKS_MIGRATION = "supabase/migrations/2026-10-22_story_blocks.sql";

/** Every table the app uses, and the file that creates it. */
export const REQUIRED_TABLES: { table: string; migration: string }[] = [
  { table: "departments", migration: SCHEMA },
  { table: "sources", migration: SCHEMA },
  { table: "raw_items", migration: SCHEMA },
  { table: "articles", migration: SCHEMA },
  { table: "agent_runs", migration: SCHEMA },
  { table: "review_log", migration: WORLD },
  { table: "pipeline_runs", migration: WORLD },
  { table: "digests", migration: DIGEST },
  { table: "digest_recipients", migration: DIGEST },
  { table: "digest_log", migration: DIGEST },
  { table: "article_submitters", migration: SUBMISSIONS_MIGRATION },
  { table: "budget_overrides", migration: RELIABILITY_MIGRATION },
  { table: "article_likes", migration: STORY_BLOCKS_MIGRATION },
  { table: "article_comments", migration: STORY_BLOCKS_MIGRATION },
  { table: "reader_login_codes", migration: STORY_BLOCKS_MIGRATION },
  { table: "reader_events", migration: STORY_BLOCKS_MIGRATION },
  { table: "comment_log", migration: STORY_BLOCKS_MIGRATION },
];

/** Columns added after a table was first created, plus the columns of the newest tables. */
export const REQUIRED_COLUMNS: { table: string; columns: string[]; migration: string }[] = [
  {
    table: "articles",
    columns: ["origin", "author_first_name", "author_last_name", "author_department", "country_code", "country_name", "review_note"],
    migration: SUBMISSIONS_MIGRATION,
  },
  { table: "articles", columns: ["summary"], migration: SUMMARY_MIGRATION },
  { table: "articles", columns: ["body_blocks", "body_format"], migration: STORY_BLOCKS_MIGRATION },
  { table: "pipeline_runs", columns: ["id", "stage", "started_at", "finished_at", "ok", "summary", "error", "triggered_by", "alert_sent"], migration: RELIABILITY_MIGRATION },
  { table: "article_submitters", columns: ["article_id", "email", "ip_hash", "email_verified", "submitted_at", "image_path"], migration: SUBMISSIONS_MIGRATION },
  {
    table: "digests",
    columns: ["id", "week_start", "status", "subject", "intro", "lead_article_id", "article_ids", "approved_by", "approved_at", "sent_at", "error", "recipient_count", "reminder_sent_at", "created_at", "updated_at"],
    migration: DIGEST,
  },
  { table: "digest_recipients", columns: ["id", "email", "active", "created_at"], migration: DIGEST },
  { table: "digest_log", columns: ["id", "digest_id", "action", "actor", "detail", "created_at"], migration: DIGEST },
  { table: "article_submitters", columns: ["first_name", "last_name", "author_department", "name_public", "image_paths"], migration: STORY_BLOCKS_MIGRATION },
];

export const REQUIRED_BUCKETS: { id: string; public: boolean }[] = [
  { id: STORAGE_BUCKETS.submissions, public: false },
  { id: STORAGE_BUCKETS.published, public: true },
];

export const REQUIRED_DEPARTMENTS = [{ slug: "ai-technology", name: "AI & Technology" }];

export type SchemaReport = {
  /** Everything present and correct. */
  ok: boolean;
  /** An unexpected database error (not a missing object): the route answers 500. */
  failed: boolean;
  counts: Record<string, number | string>;
  missingTables: { table: string; run: string }[];
  missingColumns: { table: string; column: string; run: string }[];
  /** Buckets that are missing or have the wrong visibility. */
  bucketProblems: string[];
  missingRows: string[];
  /** What the public (anon) key can or cannot read on articles, when that is wrong. */
  grantProblems: string[];
  /** One sentence for a person: what is missing and which file to run. */
  message?: string;
};

export async function checkSchema(probe: SchemaProbe): Promise<SchemaReport> {
  const report: SchemaReport = { ok: true, failed: false, counts: {}, missingTables: [], missingColumns: [], bucketProblems: [], missingRows: [], grantProblems: [] };
  const present = new Set<string>();

  for (const { table, migration } of REQUIRED_TABLES) {
    const { error, count } = await probe.table(table);
    if (!error) {
      report.counts[table] = count ?? 0;
      present.add(table);
    } else if (isMissingTable(error)) {
      report.counts[table] = `missing: run ${migration}`;
      report.missingTables.push({ table, run: migration });
    } else {
      report.counts[table] = `error: ${error.message}`;
      report.failed = true;
    }
  }

  for (const { table, columns, migration } of REQUIRED_COLUMNS) {
    if (!present.has(table)) continue; // already reported as a missing table
    const all = await probe.columns(table, columns);
    if (!all.error) continue;
    if (!isMissingColumn(all.error)) {
      report.failed = true;
      continue;
    }
    // PostgREST names only the first missing column, so ask about each one.
    for (const column of columns) {
      const one = await probe.columns(table, [column]);
      if (one.error && isMissingColumn(one.error)) report.missingColumns.push({ table, column, run: migration });
      else if (one.error) report.failed = true;
    }
  }

  for (const want of REQUIRED_BUCKETS) {
    const { error, found, isPublic } = await probe.bucket(want.id);
    if (error) {
      report.bucketProblems.push(`${want.id}: could not be checked (${error.message})`);
      report.failed = true;
    } else if (!found) {
      report.bucketProblems.push(`${want.id}: missing`);
    } else if (isPublic !== want.public) {
      report.bucketProblems.push(`${want.id}: is ${isPublic ? "public" : "private"} but must be ${want.public ? "public" : "private"}`);
    }
  }

  if (present.has("departments")) {
    for (const d of REQUIRED_DEPARTMENTS) {
      const { error, found } = await probe.department(d.slug);
      if (error) report.failed = true;
      else if (!found) report.missingRows.push(`department "${d.name}" (${d.slug})`);
    }
  }

  // The public key must read the public columns of articles, and nothing else.
  if (present.has("articles")) {
    const open = await probe.anonArticleColumns([...PUBLIC_ARTICLE_GRANTED_COLUMNS]);
    if (open.error) {
      report.grantProblems.push(`the public key cannot read the public columns of articles (${open.error.message}), so the website would show no stories`);
    }
    for (const column of INTERNAL_ARTICLE_COLUMNS) {
      const r = await probe.anonArticleColumns([column]);
      if (!r.error) report.grantProblems.push(`the public key can read articles.${column}`);
      else if (isMissingColumn(r.error)) continue; // the column does not exist (anymore): nothing to protect
    }
  }

  const parts: string[] = [];
  const files = new Set<string>();
  if (report.missingTables.length) {
    parts.push(`Missing tables: ${report.missingTables.map((m) => m.table).join(", ")}.`);
    report.missingTables.forEach((m) => files.add(m.run));
  }
  if (report.missingColumns.length) {
    parts.push(`Missing columns: ${report.missingColumns.map((m) => `${m.table}.${m.column}`).join(", ")}.`);
    report.missingColumns.forEach((m) => files.add(m.run));
  }
  if (report.bucketProblems.length) {
    parts.push(`Storage buckets: ${report.bucketProblems.join("; ")}.`);
    files.add(SUBMISSIONS_MIGRATION);
  }
  if (report.missingRows.length) {
    parts.push(`Missing rows: ${report.missingRows.join(", ")}.`);
    files.add(SUBMISSIONS_MIGRATION);
  }
  if (report.grantProblems.length) {
    parts.push(`Public access to articles: ${report.grantProblems.join("; ")}.`);
    files.add(GRANT_MIGRATION);
  }
  if (parts.length) report.message = `${parts.join(" ")} Run ${[...files].join(" and ")} in the Supabase SQL editor.`;

  report.ok = !report.failed && parts.length === 0;
  return report;
}
