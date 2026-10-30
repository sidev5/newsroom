import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { parseStoredDoc, type BlocksDoc } from "@/lib/stories/blocks";
import { isMissingColumn } from "@/lib/supabase/errors";
import type { DeptInfo } from "./review-view";

export type ReviewArticle = {
  id: string;
  headline: string;
  body: string;
  status: string;
  fact_check_notes: string | null;
  /** e.g. "Restored by editor (...), fact-check had flagged: ..."; null on articles never restored. */
  review_note: string | null;
  image_url: string | null;
  image_alt: string | null;
  image_credit: string | null;
  image_credit_url: string | null;
  source_urls: string[];
  source_published_at: string | null;
  country_code: string | null;
  country_name: string | null;
  created_at: string;
  published_at: string | null;
  department: { name: string; slug: string; kind?: "company" | "world" } | null;
  /** 'employee' for stories sent through /submit; those skip the AI pipeline entirely. */
  origin: "ai" | "employee";
  author_first_name: string | null;
  author_last_name: string | null;
  author_department: string | null;
  /** 'blocks' for a story written on the Write page; its blocks are in ody_blocks (images still private while it is pending). */
  body_format?: "plain" | "blocks";
  body_blocks?: BlocksDoc | null;
};

export type LatestLog = { action: string; actor_email: string; reason: string | null; created_at: string };

const COLUMNS =
  "id, headline, body, status, fact_check_notes, review_note, image_url, image_alt, image_credit, image_credit_url, source_urls, source_published_at, country_code, country_name, created_at, published_at, origin, author_first_name, author_last_name, author_department, departments(name, slug, kind)";

type Row = Omit<ReviewArticle, "department" | "body_blocks" | "body_format"> & {
  departments: ReviewArticle["department"] | NonNullable<ReviewArticle["department"]>[];
  body_blocks?: unknown;
  body_format?: string;
};

// The blocks columns exist after 2026-10-22_story_blocks.sql: until it is run the page selects without them.
const COLUMNS_WITH_BLOCKS = COLUMNS.replace("departments(", "body_blocks, body_format, departments(");

const LIST_LIMIT = 100;

/** Caller must have passed the admin check: this uses the service role. */
export async function loadArticles(status: "pending_review" | "published" | "rejected"): Promise<ReviewArticle[]> {
  const run = (columns: string) =>
    supabaseAdmin()
      .from("articles")
      .select(columns)
      .eq("status", status)
      // Review oldest first; the published and rejected lists show what changed most recently.
      .order(status === "pending_review" ? "created_at" : "published_at", { ascending: status === "pending_review", nullsFirst: false })
      .limit(status === "pending_review" ? 200 : LIST_LIMIT);
  let { data, error } = await run(COLUMNS_WITH_BLOCKS);
  if (error && isMissingColumn(error)) ({ data, error } = await run(COLUMNS));
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as Row[]).map(({ departments, body_blocks, body_format, ...rest }) => {
    const blocks = body_format === "blocks" ? parseStoredDoc(body_blocks) : null;
    return { ...rest, body_format: blocks ? "blocks" : "plain", body_blocks: blocks, department: (Array.isArray(departments) ? departments[0] : departments) ?? null } as ReviewArticle;
  });
}
export async function loadDepartments(): Promise<DeptInfo[]> {
  const { data, error } = await supabaseAdmin().from("departments").select("slug, name, kind");
  if (error) throw new Error(error.message);
  return (data ?? []) as DeptInfo[];
}

export async function countByStatus(): Promise<Record<"pending_review" | "published" | "rejected" | "skipped", number>> {
  const db = supabaseAdmin();
  const one = async (status: string) => {
    const { count, error } = await db.from("articles").select("*", { count: "exact", head: true }).eq("status", status);
    if (error) throw new Error(error.message);
    return count ?? 0;
  };
  const skipped = async () => {
    const { count, error } = await db.from("raw_items").select("*", { count: "exact", head: true }).eq("status", "skipped");
    if (error) throw new Error(error.message);
    return count ?? 0;
  };
  const [pending_review, published, rejected, skippedCount] = await Promise.all([one("pending_review"), one("published"), one("rejected"), skipped()]);
  return { pending_review, published, rejected, skipped: skippedCount };
}

/** Most recent audit row per article. Returns an empty map if the log table is missing. */
export async function latestLogs(articleIds: string[]): Promise<Map<string, LatestLog>> {
  const out = new Map<string, LatestLog>();
  if (articleIds.length === 0) return out;
  const { data, error } = await supabaseAdmin()
    .from("review_log")
    .select("article_id, action, actor_email, reason, created_at")
    .in("article_id", articleIds)
    .order("created_at", { ascending: false });
  if (error) return out;
  for (const row of (data ?? []) as (LatestLog & { article_id: string })[]) {
    if (!out.has(row.article_id)) out.set(row.article_id, row);
  }
  return out;
}

export type SkippedItem = {
  id: string;
  title: string;
  url: string;
  status: "skipped" | "failed";
  classify_reason: string | null;
  fetched_at: string;
  source_published_at: string | null;
  source: string | null;
  /** The classifier's department guess (raw_items.department_id). */
  department: { id: string; name: string; slug: string } | null;
};

/** Raw items the pipeline dropped, newest first. Caller must have passed the admin check. */
export async function loadSkipped(includeFailed: boolean): Promise<SkippedItem[]> {
  const { data, error } = await supabaseAdmin()
    .from("raw_items")
    .select("id, title, url, status, classify_reason, fetched_at, source_published_at, sources(name), departments(id, name, slug)")
    .in("status", includeFailed ? ["skipped", "failed"] : ["skipped"])
    .order("fetched_at", { ascending: false })
    .limit(150);
  if (error) throw new Error(error.message);
  type One<T> = T | T[] | null;
  type Row = Omit<SkippedItem, "source" | "department"> & { sources: One<{ name: string }>; departments: One<{ id: string; name: string; slug: string }> };
  const first = <T,>(v: One<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);
  return ((data ?? []) as unknown as Row[]).map(({ sources, departments, ...rest }) => ({
    ...rest,
    source: first(sources)?.name ?? null,
    department: first(departments),
  }));
}

/** Departments with ids, for the "Mark relevant" picker. */
export async function loadDepartmentOptions(): Promise<{ id: string; name: string; slug: string }[]> {
  const { data, error } = await supabaseAdmin().from("departments").select("id, name, slug").order("name");
  if (error) throw new Error(error.message);
  return (data ?? []) as { id: string; name: string; slug: string }[];
}