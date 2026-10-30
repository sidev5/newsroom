// The columns of `articles` that the anon (and authenticated) database roles may read. One list, used by
// the public queries, the health check and (through a test) the GRANT statement in the SQL files.
// A column that is not here is invisible to the public REST API, whatever a query asks for.

/** What the website shows. */
export const PUBLIC_ARTICLE_DISPLAY_COLUMNS = [
  "id",
  "slug",
  "headline",
  "body",
  "summary",
  "place",
  "lat",
  "lon",
  "country_code",
  "country_name",
  "source_urls",
  "source_published_at",
  "published_at",
  "image_url",
  "image_credit",
  "image_credit_url",
  "image_alt",
  "origin",
  "author_first_name",
  "author_last_name",
  "author_department",
  // Write stories (2026-10-22): the blocks as JSON, and which kind of body this article has. Only published rows are visible.
  "body_blocks",
  "body_format",
] as const;

/**
 * What the feed list selects: the display columns without the heavy ones. The full body (and the source date,
 * which only the reader shows) is loaded when a story is opened.
 */
export const PUBLIC_ARTICLE_LIST_COLUMNS = PUBLIC_ARTICLE_DISPLAY_COLUMNS.filter((c) => c !== "body" && c !== "source_published_at" && c !== "body_blocks" && c !== "body_format");

/**
 * Also granted because the public query needs them: `status` (the `status = 'published'` filter) and
 * `department_id` (the join to departments). Neither is sensitive: every row anon can see is published.
 */
export const PUBLIC_ARTICLE_SUPPORT_COLUMNS = ["status", "department_id"] as const;

/** Everything the database grants to anon on articles. */
export const PUBLIC_ARTICLE_GRANTED_COLUMNS: readonly string[] = [...PUBLIC_ARTICLE_DISPLAY_COLUMNS, ...PUBLIC_ARTICLE_SUPPORT_COLUMNS];

/** Columns that must never be readable by the public: internal notes, review data, links to the source item. */
export const INTERNAL_ARTICLE_COLUMNS = [
  "fact_check_notes",
  "review_note",
  "image_query",
  "raw_item_id",
  "created_at",
  "reviewed_by",
  "reviewed_at",
  "previous_status",
] as const;
