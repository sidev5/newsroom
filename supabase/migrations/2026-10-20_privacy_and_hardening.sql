-- Run in the Supabase SQL editor (as the default `postgres` role). Idempotent: safe to run again.
-- Same statements as the "Privacy and hardening (2026-10-20)" section at the end of schema.sql.
-- Run it after 2026-10-19_reliability.sql. The app keeps working before it is run, but the privacy cleanup, the
-- "Delete a person's data" tool and `npm run stage -- purge-sample` need it.

-- ---------------------------------------------------------------------------
-- 1. SEC-13: the submitter's email can be anonymized. anonymized_at marks the rows that were.
-- ---------------------------------------------------------------------------
alter table public.article_submitters add column if not exists anonymized_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. SEC-13: the log of "Delete a person's data". It never holds the email address: only a keyed hash of it, so a
--    later request ("did you delete me?") can be answered by someone who knows the address and the app's secret.
--    Service role only: no policies for anon/authenticated.
-- ---------------------------------------------------------------------------
create table if not exists public.privacy_log (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  admin_email  text not null,                      -- who did it
  action       text not null,                      -- 'erase_person'
  subject_hash text not null,                      -- HMAC-SHA256 of the lower-cased email, hex
  detail       jsonb                               -- counts and the mode chosen, no personal data
);
create index if not exists privacy_log_created_idx on public.privacy_log (created_at desc);
alter table public.privacy_log enable row level security;

-- ---------------------------------------------------------------------------
-- 3. SEC-13: retention of the submitters' personal data. Called by /api/cron/cleanup and `npm run stage -- cleanup`.
--      a. article_submitters.ip_hash is set to null after p_ip_days days (default 7);
--      b. the email is replaced by an anonymous placeholder p_email_days days (default 90) after the article's decision:
--         the latest approve or reject in review_log, else the publication date, else the submission date. Only articles
--         that are published or rejected count as decided, so a story still waiting for review keeps its author's email.
--         The placeholder is 'anonymized-<12 hex>@anonymized.invalid', and image_path is cleared (the app removes the
--         photo file from the private bucket first: the paths are returned in photo_paths).
--    p_apply = false (the default) changes nothing and returns what an apply would touch.
--    Returns {"apply", "ip_hash_cleared", "emails_anonymized", "photo_paths"}.
-- ---------------------------------------------------------------------------
create or replace function public.privacy_due(p_cutoff timestamptz) returns table (article_id uuid, image_path text)
language sql stable
set search_path = public
as $$
  select s.article_id, s.image_path
  from public.article_submitters s
  join public.articles a on a.id = s.article_id
  where s.anonymized_at is null
    and a.status in ('published', 'rejected')
    and coalesce(
          (select max(l.created_at) from public.review_log l where l.article_id = a.id and l.action in ('approve', 'reject')),
          a.published_at,
          s.submitted_at
        ) < p_cutoff;
$$;

create or replace function public.run_privacy_retention(
  p_apply      boolean     default false,
  p_ip_days    int         default 7,
  p_email_days int         default 90,
  p_now        timestamptz default now()
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_ip_cut    timestamptz;
  v_email_cut timestamptz;
  v_ip        int;
  v_email     int;
  v_paths     jsonb;
begin
  if p_ip_days < 1 or p_email_days < 1 then
    raise exception 'retention periods must be at least 1 day';
  end if;
  v_ip_cut    := p_now - make_interval(days => p_ip_days);
  v_email_cut := p_now - make_interval(days => p_email_days);

  select coalesce(jsonb_agg(image_path), '[]'::jsonb) into v_paths from public.privacy_due(v_email_cut) where image_path is not null;

  if p_apply then
    update public.article_submitters set ip_hash = null where ip_hash is not null and submitted_at < v_ip_cut;
    get diagnostics v_ip = row_count;

    update public.article_submitters s
    set email = 'anonymized-' || substr(md5(s.article_id::text), 1, 12) || '@anonymized.invalid',
        anonymized_at = p_now,
        ip_hash = null,
        image_path = null
    where s.article_id in (select d.article_id from public.privacy_due(v_email_cut) d);
    get diagnostics v_email = row_count;
  else
    select count(*) into v_ip from public.article_submitters where ip_hash is not null and submitted_at < v_ip_cut;
    select count(*) into v_email from public.privacy_due(v_email_cut);
  end if;

  return jsonb_build_object('apply', p_apply, 'ip_hash_cleared', v_ip, 'emails_anonymized', v_email, 'photo_paths', v_paths);
end;
$$;
-- ---------------------------------------------------------------------------
-- 4. Sample data: `npm run stage -- purge-sample` lists, and with --apply deletes, the test content before the pilot.
--    Sample articles: headline starting with "SAMPLE", slug starting with "sample-", a source URL on example.com/.org/.net,
--    or an employee submission whose email is a test address (example.com/.org/.net, *.test, *.invalid, localhost).
--    Sample raw items: a URL on example.com/.org/.net, or from a placeholder source. Placeholder sources:
--    rss_url starting with https://example.com/replace-me/. Deleting a source deletes its raw items (cascade); agent_runs
--    are kept (they are real spend), with the references set to null.
--    p_apply = false (the default) deletes nothing. Returns the lists, and photo_paths for the app to remove from storage.
-- ---------------------------------------------------------------------------
create or replace function public.sample_article_ids() returns setof uuid
language sql stable
set search_path = public
as $$
  select a.id
  from public.articles a
  where a.headline ilike 'sample%'
     or a.slug ilike 'sample-%'
     or exists (select 1 from unnest(a.source_urls) u where u ~* '^https?://([^/]*\.)?example\.(com|org|net)(/|$)')
     or exists (
          select 1 from public.article_submitters s
          where s.article_id = a.id
            and s.anonymized_at is null and s.email not like 'anonymized-%'   -- anonymized rows end in .invalid but are real people
            and s.email ~* '@([^@]*\.)?(example\.(com|org|net)|localhost)$|\.(test|invalid)$'
        );
$$;

create or replace function public.purge_sample_data(p_apply boolean default false) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_articles jsonb;
  v_sources  jsonb;
  v_paths    jsonb;
  v_raw      int;
  v_subs     int;
  v_del_articles int := 0;
  v_del_raw      int := 0;
  v_del_sources  int := 0;
begin
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'headline', a.headline, 'status', a.status, 'origin', a.origin, 'image_url', a.image_url)), '[]'::jsonb)
    into v_articles
  from public.articles a where a.id in (select public.sample_article_ids());

  select count(*) into v_subs from public.article_submitters where article_id in (select public.sample_article_ids());
  select coalesce(jsonb_agg(image_path), '[]'::jsonb) into v_paths
    from public.article_submitters where article_id in (select public.sample_article_ids()) and image_path is not null;

  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'rss_url', rss_url)), '[]'::jsonb) into v_sources
    from public.sources where rss_url ilike 'https://example.com/replace-me/%';

  select count(*) into v_raw from public.raw_items r
  where r.url ~* '^https?://([^/]*\.)?example\.(com|org|net)(/|$)'
     or r.source_id in (select id from public.sources where rss_url ilike 'https://example.com/replace-me/%');

  if p_apply then
    delete from public.articles where id in (select public.sample_article_ids());      -- article_submitters rows go with them
    get diagnostics v_del_articles = row_count;
    delete from public.raw_items r
    where r.url ~* '^https?://([^/]*\.)?example\.(com|org|net)(/|$)'
       or r.source_id in (select id from public.sources where rss_url ilike 'https://example.com/replace-me/%');
    get diagnostics v_del_raw = row_count;
    delete from public.sources where rss_url ilike 'https://example.com/replace-me/%';
    get diagnostics v_del_sources = row_count;
  end if;

  return jsonb_build_object(
    'apply', p_apply,
    'articles', v_articles,
    'submissions', v_subs,
    'raw_items', v_raw,
    'sources', v_sources,
    'photo_paths', v_paths,
    'deleted', jsonb_build_object('articles', v_del_articles, 'raw_items', v_del_raw, 'sources', v_del_sources)
  );
end;
$$;
-- Only the service role (the app's server code) may run them: they delete or change rows.
revoke all on function public.privacy_due(timestamptz) from public, anon, authenticated;
revoke all on function public.sample_article_ids() from public, anon, authenticated;
revoke all on function public.run_privacy_retention(boolean, int, int, timestamptz) from public, anon, authenticated;
grant execute on function public.run_privacy_retention(boolean, int, int, timestamptz) to service_role;
revoke all on function public.purge_sample_data(boolean) from public, anon, authenticated;
grant execute on function public.purge_sample_data(boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Make the API pick up the new column, table and functions now
-- ---------------------------------------------------------------------------
notify pgrst, 'reload schema';
