-- Run in the Supabase SQL editor (as the default `postgres` role). Idempotent: safe to run again.
-- Same statements as the "Security and indexes (2026-10-17)" section at the end of schema.sql.
-- Run it after 2026-10-15-ai-tech-and-submissions.sql (it grants columns that migration adds).
-- If you ever run this file again, run 2026-10-18_article_summary.sql after it: step 2 below resets the grant to
-- the older list, which has no `summary` column, and the homepage needs that column.

-- ---------------------------------------------------------------------------
-- 1. SEC-01: remove email addresses from the two free-text columns the public API can read.
--    Old restore notes read "Restored by editor (admin@company.com), ...".
-- ---------------------------------------------------------------------------
update public.articles
set review_note = regexp_replace(review_note, '[A-Za-z0-9._%+''-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}', 'an editor', 'g')
where review_note ~ '@';

update public.articles
set fact_check_notes = regexp_replace(fact_check_notes, '[A-Za-z0-9._%+''-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}', 'an editor', 'g')
where fact_check_notes ~ '@';

-- ---------------------------------------------------------------------------
-- 2. SEC-02: the anon and authenticated roles may read only the public columns of articles.
--    Row access is still limited by the RLS policy (status = 'published'). Anything not listed here
--    (fact_check_notes, review_note, image_query, raw_item_id, created_at, reviewed_by, reviewed_at,
--    previous_status) is invisible to the public REST API, and `select=*` as anon now fails.
--    A column added to articles later is private until it is added to this list AND to
--    lib/news/public-columns.ts (a test keeps the two in step).
-- ---------------------------------------------------------------------------
revoke select on public.articles from anon, authenticated;
grant select (
  id, slug, headline, body, place, lat, lon, country_code, country_name, source_urls,
  source_published_at, published_at, image_url, image_credit, image_credit_url, image_alt,
  origin, author_first_name, author_last_name, author_department,
  status, department_id
) on public.articles to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. DB-02: indexes on foreign keys, so deletes and cascades do not scan the child tables.
-- ---------------------------------------------------------------------------
create index if not exists raw_items_source_idx     on public.raw_items (source_id);
create index if not exists raw_items_department_idx on public.raw_items (department_id);
create index if not exists articles_department_idx  on public.articles (department_id);
create index if not exists sources_department_idx   on public.sources (department_id);
create index if not exists agent_runs_article_idx   on public.agent_runs (article_id);
create index if not exists agent_runs_raw_item_idx  on public.agent_runs (raw_item_id);

-- ---------------------------------------------------------------------------
-- 4. DB-06: pause the placeholder feeds from seed.sql (they fail on every ingest). Rows are kept.
-- ---------------------------------------------------------------------------
update public.sources
set active = false
where rss_url like 'https://example.com/replace-me/%' and active;

-- ---------------------------------------------------------------------------
-- 5. Make the API pick up the grant changes now
-- ---------------------------------------------------------------------------
notify pgrst, 'reload schema';
