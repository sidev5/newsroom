import "server-only";
import { unstable_cache } from "next/cache";
import { isMissingColumn } from "@/lib/supabase/errors";
import { supabasePublic } from "@/lib/supabase/public";
import { STORIES_TAG } from "./cache-tag";
import { parseStoredDoc } from "@/lib/stories/blocks";
import { makeSummary } from "./format";
import { PUBLIC_ARTICLE_DISPLAY_COLUMNS, PUBLIC_ARTICLE_LIST_COLUMNS } from "./public-columns";
import type { FeedPage, FeedStory, Story, StoryDepartment } from "./types";

// Anon-key client without cookies: RLS only exposes published articles (and department names), so no source text,
// drafts or raw items can come back from here. The columns are listed one by one (never "*"), and
// toStory/toFeedStory copy the same fields one by one, so a column added to the table later (or a stray field in a
// row) cannot reach the browser by accident. An author's email is not in `articles` at all: it is in
// article_submitters, which has no public policy.
// The database enforces the same list: anon has SELECT on exactly PUBLIC_ARTICLE_GRANTED_COLUMNS (see
// supabase/migrations/2026-10-18_article_summary.sql), so a column added here without a grant fails loudly.
const JOIN = "departments(name, slug, kind)";

/** The full story (reader, article page). */
export const PUBLIC_ARTICLE_COLUMNS = `${PUBLIC_ARTICLE_DISPLAY_COLUMNS.join(", ")}, ${JOIN}`;
/** The feed list: no body. */
export const PUBLIC_FEED_COLUMNS = `${PUBLIC_ARTICLE_LIST_COLUMNS.join(", ")}, ${JOIN}`;

// Used only while the 2026-10-15 / 2026-10-18 migrations have not been run yet: the same lists without the columns
// those migrations add. Without `summary` the feed also needs `body`, and the summary is cut from it in code.
const WITHOUT_SUMMARY = (c: string) => c !== "summary";
const WITHOUT_BLOCKS = (c: string) => c !== "body_blocks" && c !== "body_format"; // 2026-10-22 not run yet
const WITHOUT_AUTHORS = (c: string) => !["origin", "author_first_name", "author_last_name", "author_department"].includes(c);
const columnList = (cols: readonly string[]) => `${cols.join(", ")}, ${JOIN}`;
const FEED_FALLBACKS = [
  columnList(["body", ...PUBLIC_ARTICLE_LIST_COLUMNS].filter(WITHOUT_SUMMARY)),
  columnList(["body", ...PUBLIC_ARTICLE_LIST_COLUMNS].filter(WITHOUT_SUMMARY).filter(WITHOUT_AUTHORS)),
];
const STORY_FALLBACKS = [
  columnList(PUBLIC_ARTICLE_DISPLAY_COLUMNS.filter(WITHOUT_BLOCKS)),
  columnList(PUBLIC_ARTICLE_DISPLAY_COLUMNS.filter(WITHOUT_BLOCKS).filter(WITHOUT_SUMMARY)),
  columnList(PUBLIC_ARTICLE_DISPLAY_COLUMNS.filter(WITHOUT_BLOCKS).filter(WITHOUT_SUMMARY).filter(WITHOUT_AUTHORS)),
];

type Row = Omit<Story, "department" | "origin" | "summary" | "body" | "source_published_at" | "author_first_name" | "author_last_name" | "author_department" | "body_blocks" | "body_format"> &
  Partial<Pick<Story, "origin" | "summary" | "body" | "source_published_at" | "author_first_name" | "author_last_name" | "author_department">> & {
    body_blocks?: unknown;
    body_format?: unknown;
    departments: StoryDepartment | StoryDepartment[] | null;
  };

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Copies exactly the fields the feed needs from a database row. */
export function toFeedStory(row: Row): FeedStory {
  const dept = (Array.isArray(row.departments) ? row.departments[0] : row.departments) ?? null;
  const employee = row.origin === "employee";
  return {
    id: row.id,
    slug: row.slug,
    headline: row.headline,
    summary: text(row.summary) ?? (typeof row.body === "string" ? makeSummary(row.body) : ""),
    department: dept ? { name: dept.name, slug: dept.slug, ...(dept.kind ? { kind: dept.kind } : {}) } : null,
    place: text(row.place),
    lat: num(row.lat),
    lon: num(row.lon),
    country_code: text(row.country_code),
    country_name: text(row.country_name),
    source_urls: Array.isArray(row.source_urls) ? row.source_urls.filter((u): u is string => typeof u === "string") : [],
    published_at: text(row.published_at),
    image_url: text(row.image_url),
    image_credit: text(row.image_credit),
    image_credit_url: text(row.image_credit_url),
    image_alt: text(row.image_alt),
    origin: employee ? "employee" : "ai",
    author_first_name: employee ? text(row.author_first_name) : null,
    author_last_name: employee ? text(row.author_last_name) : null,
    author_department: employee ? text(row.author_department) : null,
  };
}

/** Copies exactly the fields of Story from a database row. */
export function toStory(row: Row): Story {
  const { summary, ...feed } = toFeedStory(row);
  const body = text(row.body) ?? "";
  // Blocks are shown only when they parse: a stored document that does not (a bad edit, a newer version) falls back to the plain text.
  const blocks = row.body_format === "blocks" ? parseStoredDoc(row.body_blocks) : null;
  return { ...feed, summary, body, source_published_at: text(row.source_published_at), body_format: blocks ? "blocks" : "plain", body_blocks: blocks };
}

type Result = { data: unknown; error: { code?: string; message: string } | null };

/** Runs the query with the current column list, then with the older lists while a migration is still missing. */
async function withFallbacks(run: (columns: string) => PromiseLike<Result>, current: string, fallbacks: string[]): Promise<unknown> {
  let { data, error } = await run(current);
  for (const columns of fallbacks) {
    if (!(error && isMissingColumn(error))) break;
    ({ data, error } = await run(columns));
  }
  if (error) throw new Error(error.message);
  return data;
}

export const FEED_PAGE_SIZE = 60;
/** Upper bound for any page size asked of getFeedPage (the HTTP route only ever uses FEED_PAGE_SIZE). */
export const FEED_PAGE_MAX = 100;

async function fetchFeedPage(offset: number, limit: number): Promise<FeedPage> {
  const db = supabasePublic();
  // One extra row tells whether there is a next page without a second count query.
  const query = (columns: string) =>
    db
      .from("articles")
      .select(columns)
      .eq("status", "published")
      .order("published_at", { ascending: false, nullsFirst: false })
      .range(offset, offset + limit);
  const data = await withFallbacks(query, PUBLIC_FEED_COLUMNS, FEED_FALLBACKS);
  const rows = (data ?? []) as unknown as Row[];
  return { stories: rows.slice(0, limit).map(toFeedStory), hasMore: rows.length > limit };
}

async function fetchStory(slug: string): Promise<Story | null> {
  const db = supabasePublic();
  const query = (columns: string) => db.from("articles").select(columns).eq("status", "published").eq("slug", slug).maybeSingle();
  const data = await withFallbacks(query, PUBLIC_ARTICLE_COLUMNS, STORY_FALLBACKS);
  return data ? toStory(data as unknown as Row) : null;
}

const CACHE = { tags: [STORIES_TAG], revalidate: 60 };

const cachedFeedPage = unstable_cache(fetchFeedPage, ["feed-page"], CACHE);
const cachedStory = unstable_cache(fetchStory, ["story"], CACHE);

/** Published stories without their bodies, newest first. Throws on a database error so the page can show it. */
export function getFeedPage(offset = 0, limit = FEED_PAGE_SIZE): Promise<FeedPage> {
  const safeLimit = Math.min(FEED_PAGE_MAX, Math.max(1, Math.floor(limit) || FEED_PAGE_SIZE));
  const safeOffset = Math.max(0, Math.floor(offset) || 0);
  return cachedFeedPage(safeOffset, safeLimit);
}

/** One published story with its full body, or null when it does not exist or is not published. */
export function getStoryBySlug(slug: string): Promise<Story | null> {
  return cachedStory(slug);
}
