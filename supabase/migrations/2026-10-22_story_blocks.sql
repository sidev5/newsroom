-- Run in the Supabase SQL editor. Safe to re-run. Same statements as the "Story blocks (2026-10-22)" section of schema.sql.
--
-- The "Write" page: stories made of blocks, likes and comments.
--   1. articles.body_blocks / body_format, and the public column grant (it now includes the two new columns).
--   2. article_submitters: the author's real name and whether it may be shown, and the private image paths of a blocks story.
--   3. article_likes, article_comments, reader_login_codes, reader_events, comment_log (row-level security on, nothing public
--      except visible comments on published articles and like COUNTS, through a view that never shows who liked).
--   4. The retention functions also remove the new personal data (names, block images).
-- Run it after 2026-10-20_privacy_and_hardening.sql.

-- ---------------------------------------------------------------------------
-- 1. Articles: block content. Existing articles stay 'plain' and keep working unchanged.
-- ---------------------------------------------------------------------------
alter table public.articles add column if not exists body_blocks jsonb;                          -- { "v": 1, "blocks": [...] }, only for body_format = 'blocks'
alter table public.articles add column if not exists body_format text not null default 'plain';  -- 'plain' (AI articles, old stories) or 'blocks' (Write)
alter table public.articles drop constraint if exists articles_body_format_check;
alter table public.articles add constraint articles_body_format_check check (body_format in ('plain', 'blocks'));
alter table public.articles drop constraint if exists articles_blocks_check;
alter table public.articles add constraint articles_blocks_check
  check (body_format <> 'blocks' or (body_blocks is not null and jsonb_typeof(body_blocks) = 'object' and octet_length(body_blocks::text) <= 400000));

-- The public key reads only the listed columns (see lib/news/public-columns.ts; a test keeps the two in step).
revoke select on public.articles from anon, authenticated;
grant select (
  id, slug, headline, body, summary, place, lat, lon, country_code, country_name, source_urls,
  source_published_at, published_at, image_url, image_credit, image_credit_url, image_alt,
  origin, author_first_name, author_last_name, author_department,
  body_blocks, body_format,
  status, department_id
) on public.articles to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The submitter's private details for a blocks story.
--    The public byline columns of articles hold the author's name only when name_public is true; otherwise they hold
--    "Newsroom" / "contributor" and the real name is only here, where only the service role can read it.
-- ---------------------------------------------------------------------------
alter table public.article_submitters add column if not exists first_name text;
alter table public.article_submitters add column if not exists last_name text;
alter table public.article_submitters add column if not exists author_department text;                      -- the author's own department (public on the story only when name_public)
alter table public.article_submitters add column if not exists name_public boolean not null default true;
alter table public.article_submitters add column if not exists image_paths text[] not null default '{}';   -- objects in the private bucket (images of the blocks)

-- ---------------------------------------------------------------------------
-- 3. Likes and comments. Readers prove a company email with a one-time code; only a keyed hash of it (user_key) is stored.
-- ---------------------------------------------------------------------------
create table if not exists public.article_likes (
  article_id uuid not null references public.articles(id) on delete cascade,
  user_key   text not null,                       -- HMAC of the lower-cased company email, hex. Never the address.
  created_at timestamptz not null default now(),
  primary key (article_id, user_key)              -- one like per person and story
);
create index if not exists article_likes_user_idx on public.article_likes (user_key);

create table if not exists public.article_comments (
  id           uuid primary key default gen_random_uuid(),
  article_id   uuid not null references public.articles(id) on delete cascade,
  user_key     text not null,
  display_name text not null,                     -- first name from the email, shown next to the comment
  body         text not null check (char_length(body) between 1 and 1000),
  status       text not null default 'visible' check (status in ('visible', 'hidden')),
  created_at   timestamptz not null default now()
);
create index if not exists article_comments_article_idx on public.article_comments (article_id, created_at desc);
create index if not exists article_comments_user_idx    on public.article_comments (user_key, created_at desc);

-- One-time sign-in codes (hashed) and the like-toggle log that the rate limits count.
create table if not exists public.reader_login_codes (
  id         uuid primary key default gen_random_uuid(),
  email_key  text not null,
  code_hash  text not null,
  ip_hash    text,
  attempts   int  not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);
create index if not exists reader_login_codes_email_idx on public.reader_login_codes (email_key, created_at desc);
create index if not exists reader_login_codes_ip_idx    on public.reader_login_codes (ip_hash, created_at desc);

create table if not exists public.reader_events (
  id         uuid primary key default gen_random_uuid(),
  user_key   text not null,
  kind       text not null check (kind in ('like')),
  created_at timestamptz not null default now()
);
create index if not exists reader_events_user_idx on public.reader_events (user_key, kind, created_at desc);

-- A wrong-code try is counted BEFORE the code is compared, in one atomic statement, so a hundred parallel guesses still
-- get only READER_LIMITS.CODE_MAX_ATTEMPTS tries. Returns the number of tries used, or null when none are left (or the code is used).
create or replace function public.reader_code_attempt(p_id uuid, p_max int) returns int
language sql
set search_path = public
as $$
  update public.reader_login_codes
  set attempts = attempts + 1
  where id = p_id and attempts < p_max and used_at is null
  returning attempts;
$$;
revoke all on function public.reader_code_attempt(uuid, int) from public, anon, authenticated;
grant execute on function public.reader_code_attempt(uuid, int) to service_role;

-- Audit of comment moderation: who hid or restored which comment, when and why.
create table if not exists public.comment_log (
  id          uuid primary key default gen_random_uuid(),
  comment_id  uuid references public.article_comments(id) on delete set null,
  article_id  uuid references public.articles(id) on delete set null,
  action      text not null check (action in ('hide', 'unhide')),
  actor_email text not null,
  reason      text,
  created_at  timestamptz not null default now()
);
create index if not exists comment_log_comment_idx on public.comment_log (comment_id, created_at desc);

alter table public.article_likes       enable row level security;
alter table public.article_comments    enable row level security;
alter table public.reader_login_codes  enable row level security;
alter table public.reader_events       enable row level security;
alter table public.comment_log         enable row level security;

-- No access for the public key at all, except what is granted below. Writes happen only through server routes (service role).
revoke all on public.article_likes      from anon, authenticated;
revoke all on public.article_comments   from anon, authenticated;
revoke all on public.reader_login_codes from anon, authenticated;
revoke all on public.reader_events      from anon, authenticated;
revoke all on public.comment_log        from anon, authenticated;

-- Comments: visible ones on published articles, and not the user_key.
grant select (id, article_id, display_name, body, status, created_at) on public.article_comments to anon, authenticated;
drop policy if exists "public reads visible comments" on public.article_comments;
create policy "public reads visible comments"
  on public.article_comments for select
  to anon, authenticated
  using (status = 'visible' and exists (select 1 from public.articles a where a.id = article_id and a.status = 'published'));

-- Like counts for published articles. The view runs with its owner's rights, so the public key needs no access to
-- article_likes, and the view never shows who liked.
create or replace view public.article_like_counts as
  select l.article_id, count(*)::int as likes
  from public.article_likes l
  join public.articles a on a.id = l.article_id and a.status = 'published'
  group by l.article_id;
revoke all on public.article_like_counts from public, anon, authenticated;
grant select on public.article_like_counts to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Retention. The same rules as before, now also for the author's real name and the private images of a blocks story.
--    (privacy_due and sample_article_ids are unchanged: only these two functions are replaced.)
-- ---------------------------------------------------------------------------
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

  select coalesce(jsonb_agg(q.p), '[]'::jsonb) into v_paths
  from (
    select d.image_path as p from public.privacy_due(v_email_cut) d where d.image_path is not null
    union all
    select unnest(s.image_paths) from public.article_submitters s where s.article_id in (select d.article_id from public.privacy_due(v_email_cut) d)
  ) q;

  if p_apply then
    update public.article_submitters set ip_hash = null where ip_hash is not null and submitted_at < v_ip_cut;
    get diagnostics v_ip = row_count;

    update public.article_submitters s
    set email = 'anonymized-' || substr(md5(s.article_id::text), 1, 12) || '@anonymized.invalid',
        anonymized_at = p_now,
        ip_hash = null,
        image_path = null,
        image_paths = '{}',
        first_name = null,
        last_name = null,
        author_department = null
    where s.article_id in (select d.article_id from public.privacy_due(v_email_cut) d);
    get diagnostics v_email = row_count;
  else
    select count(*) into v_ip from public.article_submitters where ip_hash is not null and submitted_at < v_ip_cut;
    select count(*) into v_email from public.privacy_due(v_email_cut);
  end if;

  return jsonb_build_object('apply', p_apply, 'ip_hash_cleared', v_ip, 'emails_anonymized', v_email, 'photo_paths', v_paths);
end;
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
  select coalesce(jsonb_agg(q.p), '[]'::jsonb) into v_paths
  from (
    select s.image_path as p from public.article_submitters s where s.article_id in (select public.sample_article_ids()) and s.image_path is not null
    union all
    select unnest(s.image_paths) from public.article_submitters s where s.article_id in (select public.sample_article_ids())
  ) q;

  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'rss_url', rss_url)), '[]'::jsonb) into v_sources
    from public.sources where rss_url ilike 'https://example.com/replace-me/%';

  select count(*) into v_raw from public.raw_items r
  where r.url ~* '^https?://([^/]*\.)?example\.(com|org|net)(/|$)'
     or r.source_id in (select id from public.sources where rss_url ilike 'https://example.com/replace-me/%');

  if p_apply then
    delete from public.articles where id in (select public.sample_article_ids());      -- submitters, likes and comments go with them
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

revoke all on function public.run_privacy_retention(boolean, int, int, timestamptz) from public, anon, authenticated;
grant execute on function public.run_privacy_retention(boolean, int, int, timestamptz) to service_role;
revoke all on function public.purge_sample_data(boolean) from public, anon, authenticated;
grant execute on function public.purge_sample_data(boolean) to service_role;

notify pgrst, 'reload schema';
