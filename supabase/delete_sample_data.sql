-- Delete SAMPLE / test content before the pilot. Run in the Supabase SQL editor.
--
-- What counts as sample data (edit the conditions below if yours differ):
--   articles:  headline starts with "SAMPLE", slug starts with "sample-", or any source URL
--              is on example.com / example.org / example.net (the placeholder feeds in seed.sql)
--   raw_items: URL on example.com / example.org / example.net, or fetched from a source whose
--              rss_url is still a placeholder ("https://example.com/replace-me/...")
--
-- Safe by default: everything runs in a transaction that ends in ROLLBACK, so the first run only
-- shows what WOULD be deleted. Check the counts, then change the last line to COMMIT and run again.
-- agent_runs rows are kept (they are real spend); their article_id / raw_item_id become null.
-- departments and sources are never touched.

begin;

-- 1. Preview
select 'articles to delete' as what, count(*) as n, count(*) filter (where status = 'published') as published
from public.articles
where headline ilike 'sample%'
   or slug ilike 'sample-%'
   or exists (select 1 from unnest(source_urls) u where u ~* '^https?://([^/]*\.)?example\.(com|org|net)(/|$)');

select 'raw_items to delete' as what, count(*) as n
from public.raw_items r
where r.url ~* '^https?://([^/]*\.)?example\.(com|org|net)(/|$)'
   or r.source_id in (select id from public.sources where rss_url ilike 'https://example.com/replace-me/%');

-- 2. Delete articles first, then raw items
delete from public.articles
where headline ilike 'sample%'
   or slug ilike 'sample-%'
   or exists (select 1 from unnest(source_urls) u where u ~* '^https?://([^/]*\.)?example\.(com|org|net)(/|$)');

delete from public.raw_items r
where r.url ~* '^https?://([^/]*\.)?example\.(com|org|net)(/|$)'
   or r.source_id in (select id from public.sources where rss_url ilike 'https://example.com/replace-me/%');

-- 3. What is left
select (select count(*) from public.articles)  as articles_left,
       (select count(*) from public.raw_items) as raw_items_left;

-- Change to COMMIT once the preview looks right.
rollback;
