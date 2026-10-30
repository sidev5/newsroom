import { INTERNAL_ARTICLE_COLUMNS, PUBLIC_ARTICLE_GRANTED_COLUMNS } from "@/lib/news/public-columns";

// SEC-04: what the PUBLIC (anon) key can read, table by table. `npm run check-rls` runs this with the real key.
// The rule: nothing, except the published rows of articles (only their granted columns) and the department names.
// Plain module: the probe is injected, so the verdicts are tested without a database. It only reads, and it never prints row contents.

export type ProbeResult = { rows: Record<string, unknown>[]; error: { code?: string; message: string } | null };

export interface RlsProbe {
  /** `select <columns> from <table> limit 5` with the public key. */
  select(table: string, columns: string): Promise<ProbeResult>;
  /** How many rows the table really has (service role, read only), or null when that cannot be asked. */
  serviceCount?(table: string): Promise<number | null>;
}

/** Tables the public key must not read at all. */
export const PRIVATE_TABLES = [
  "sources",
  "raw_items",
  "agent_runs",
  "review_log",
  "pipeline_runs",
  "digests",
  "digest_recipients",
  "digest_log",
  "article_submitters",
  "budget_overrides",
  "privacy_log",
  // Write (2026-10-22): who liked what, the sign-in codes and the moderation log are never public.
  "article_likes",
  "reader_login_codes",
  "reader_events",
  "comment_log",
] as const;

export type RlsStatus = "ok" | "fail" | "warn";
export type RlsResult = { table: string; status: RlsStatus; message: string };

const DENIED = "42501"; // permission denied
const MISSING_TABLE = new Set(["PGRST205", "42P01"]);
const MISSING_COLUMN = new Set(["42703", "PGRST204"]);

async function privateTable(probe: RlsProbe, table: string): Promise<RlsResult> {
  const { rows, error } = await probe.select(table, "*");
  if (error) {
    if (error.code === DENIED || /permission denied/i.test(error.message)) return { table, status: "ok", message: "nothing readable (permission denied)" };
    if (error.code && MISSING_TABLE.has(error.code)) return { table, status: "warn", message: "not found in the API schema: has its migration been run?" };
    return { table, status: "warn", message: `could not be checked (${error.code ?? "error"}: ${error.message.slice(0, 80)})` };
  }
  if (rows.length > 0) return { table, status: "fail", message: `THE PUBLIC KEY CAN READ ROWS (${rows.length} returned; columns: ${Object.keys(rows[0]).join(", ")})` };
  const real = await probe.serviceCount?.(table).catch(() => null);
  if (typeof real === "number" && real > 0) return { table, status: "ok", message: `public sees 0 rows, the service role sees ${real}: row-level security is hiding them` };
  return { table, status: "warn", message: "public sees 0 rows, but the table is empty (or its size is unknown), so this does not prove the rows are protected: add a row and run it again" };
}

async function departments(probe: RlsProbe): Promise<RlsResult> {
  const { rows, error } = await probe.select("departments", "*");
  if (error) return { table: "departments", status: "fail", message: `the public pages need the department names but the public key cannot read them (${error.message.slice(0, 80)})` };
  return { table: "departments", status: "ok", message: `readable by design (${rows.length} rows; columns: ${rows[0] ? Object.keys(rows[0]).join(", ") : "none returned"})` };
}

async function articles(probe: RlsProbe): Promise<RlsResult[]> {
  const out: RlsResult[] = [];

  // 1. select=* must fail: the public key has column-level grants only.
  const star = await probe.select("articles", "*");
  if (!star.error) {
    out.push({ table: "articles", status: "fail", message: "select=* WORKS for the public key: the column grants are missing, so internal columns are readable. Run supabase/migrations/2026-10-18_article_summary.sql" });
  } else if (star.error.code === DENIED || /permission denied/i.test(star.error.message)) {
    out.push({ table: "articles", status: "ok", message: "select=* is refused (column-level grants)" });
  } else {
    out.push({ table: "articles", status: "warn", message: `select=* failed for another reason (${star.error.code ?? "error"}: ${star.error.message.slice(0, 80)})` });
  }

  // 2. The granted columns: only published rows come back.
  const granted = await probe.select("articles", PUBLIC_ARTICLE_GRANTED_COLUMNS.join(","));
  if (granted.error) {
    out.push({ table: "articles (public columns)", status: "fail", message: `the public pages could not read their columns (${granted.error.code ?? "error"}: ${granted.error.message.slice(0, 80)})` });
  } else {
    const notPublished = granted.rows.filter((r) => r.status !== "published").length;
    out.push(
      notPublished > 0
        ? { table: "articles (public columns)", status: "fail", message: `${notPublished} of ${granted.rows.length} rows are NOT published: drafts are visible to the public key` }
        : { table: "articles (public columns)", status: "ok", message: `${granted.rows.length} rows, all published` },
    );
  }

  // 3. Each internal column, one by one: none may be readable.
  const open: string[] = [];
  for (const column of INTERNAL_ARTICLE_COLUMNS) {
    const r = await probe.select("articles", column);
    if (!r.error) open.push(column);
    else if (r.error.code && MISSING_COLUMN.has(r.error.code)) continue; // the column does not exist (any more): nothing to protect
  }
  out.push(
    open.length > 0
      ? { table: "articles (internal columns)", status: "fail", message: `THE PUBLIC KEY CAN READ: ${open.join(", ")}` }
      : { table: "articles (internal columns)", status: "ok", message: `${INTERNAL_ARTICLE_COLUMNS.join(", ")}: none readable` },
  );
  return out;
}

/** Comments: only the visible ones of published articles, and never the user key. */
async function comments(probe: RlsProbe): Promise<RlsResult[]> {
  const table = "article_comments";
  const out: RlsResult[] = [];
  const key = await probe.select(table, "user_key");
  if (key.error && key.error.code && MISSING_TABLE.has(key.error.code)) return [{ table, status: "warn", message: "not found in the API schema: has 2026-10-22_story_blocks.sql been run?" }];
  out.push(
    key.error
      ? { table: `${table} (user_key)`, status: "ok", message: "not readable (column-level grants)" }
      : { table: `${table} (user_key)`, status: "fail", message: "THE PUBLIC KEY CAN READ user_key: it identifies who wrote each comment" },
  );
  const star = await probe.select(table, "*");
  if (!star.error) out.push({ table: `${table} (select *)`, status: "fail", message: "select=* WORKS for the public key: the column grants are missing" });
  const shown = await probe.select(table, "id, article_id, display_name, body, status, created_at");
  if (shown.error) {
    out.push({ table: `${table} (public columns)`, status: "warn", message: `could not be read (${shown.error.code ?? "error"}: ${shown.error.message.slice(0, 80)})` });
  } else {
    const hidden = shown.rows.filter((r) => r.status !== "visible").length;
    out.push(
      hidden > 0
        ? { table: `${table} (public columns)`, status: "fail", message: `${hidden} of ${shown.rows.length} comments are NOT visible: hidden comments are readable by the public key` }
        : { table: `${table} (public columns)`, status: "ok", message: `${shown.rows.length} rows, all visible` },
    );
  }
  return out;
}

/** Like counts are public by design, but only counts: no user key. */
async function likeCounts(probe: RlsProbe): Promise<RlsResult> {
  const table = "article_like_counts";
  const { rows, error } = await probe.select(table, "*");
  if (error) return { table, status: "warn", message: `could not be read (${error.code ?? "error"}: ${error.message.slice(0, 80)}): has 2026-10-22_story_blocks.sql been run?` };
  const columns = rows[0] ? Object.keys(rows[0]).sort().join(",") : "article_id,likes";
  return columns === "article_id,likes" ? { table, status: "ok", message: `readable by design: counts only (${rows.length} rows)` } : { table, status: "fail", message: `the view shows more than counts (columns: ${columns})` };
}
export async function runRlsCheck(probe: RlsProbe): Promise<{ results: RlsResult[]; ok: boolean }> {
  const results: RlsResult[] = [await departments(probe), ...(await articles(probe)), ...(await comments(probe)), await likeCounts(probe)];
  for (const table of PRIVATE_TABLES) results.push(await privateTable(probe, table));
  return { results, ok: results.every((r) => r.status !== "fail") };
}

const MARK: Record<RlsStatus, string> = { ok: "OK  ", warn: "WARN", fail: "FAIL" };

export function formatRls(results: RlsResult[]): string {
  const width = Math.max(...results.map((r) => r.table.length));
  const lines = results.map((r) => `${MARK[r.status]}  ${r.table.padEnd(width)}  ${r.message}`);
  const fails = results.filter((r) => r.status === "fail").length;
  const warns = results.filter((r) => r.status === "warn").length;
  lines.push("", fails > 0 ? `${fails} problem${fails === 1 ? "" : "s"}: the public key can read more than it should.` : `The public key reads nothing it should not${warns ? ` (${warns} warning${warns === 1 ? "" : "s"}: see above)` : ""}.`);
  return lines.join("\n");
}
