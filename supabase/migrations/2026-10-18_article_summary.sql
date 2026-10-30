-- Run in the Supabase SQL editor (as the default `postgres` role). Idempotent: safe to run again.
-- Same statements as the "Article summary (2026-10-18)" parts of schema.sql.
-- Run it after 2026-10-17_security_and_indexes.sql, and BEFORE deploying the code that writes `summary`
-- (the AI writer and /submit insert it; the homepage list reads it).
-- PERF-01: the homepage list no longer carries every full body. Each article keeps a stored summary
-- (the first 240 characters of the body, cut at a word boundary) that the feed cards show.

-- ---------------------------------------------------------------------------
-- 1. The column. Filled at write time (AI articles), at submission time (employee stories) and whenever an
--    editor changes the body. Null only for rows that exist before step 2 has run.
-- ---------------------------------------------------------------------------
alter table public.articles add column if not exists summary text;

-- ---------------------------------------------------------------------------
-- 2. Backfill existing rows (only the ones without a summary yet). Same rule as makeSummary() in
--    lib/news/format.ts: collapse whitespace; if it is longer than 240 characters keep the first 240, cut at
--    the last space when that space is after character 144 (60 %), drop trailing punctuation, add "…".
-- ---------------------------------------------------------------------------
update public.articles a
set summary = s.v
from (
  select
    id,
    case
      when length(n) <= 240 then n
      else regexp_replace(
             case
               when position(' ' in cut) > 0 and length(regexp_replace(cut, ' [^ ]*$', '')) > 144
                 then regexp_replace(cut, ' [^ ]*$', '')
               else cut
             end,
             '[\s,;:.-]+$', ''
           ) || '…'
    end as v
  from (
    select id, n, left(n, 240) as cut
    from (
      select id, btrim(regexp_replace(body, '\s+', ' ', 'g')) as n
      from public.articles
      where summary is null or summary = ''
    ) norm
  ) cutting
) s
where a.id = s.id;

-- ---------------------------------------------------------------------------
-- 3. The anon and authenticated roles may read the new column. This is the full current list (it replaces the
--    list of 2026-10-17): lib/news/public-columns.ts keeps the same list and a test keeps the two in step.
-- ---------------------------------------------------------------------------
revoke select on public.articles from anon, authenticated;
grant select (
  id, slug, headline, body, summary, place, lat, lon, country_code, country_name, source_urls,
  source_published_at, published_at, image_url, image_credit, image_credit_url, image_alt,
  origin, author_first_name, author_last_name, author_department,
  status, department_id
) on public.articles to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Make the API pick up the new column and grant now
-- ---------------------------------------------------------------------------
notify pgrst, 'reload schema';
