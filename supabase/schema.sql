-- AI Newsroom schema. Safe to re-run: uses IF NOT EXISTS / OR REPLACE where possible.
-- Run in the Supabase SQL editor (or `psql`) before seed.sql.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- departments
-- ---------------------------------------------------------------------------
create table if not exists public.departments (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  slug        text not null unique,            -- used in URLs (?dept=ev) and default image names
  description text not null default '',
  keywords    text[] not null default '{}'     -- lowercase; used by the classify pre-check
);

-- ---------------------------------------------------------------------------
-- sources (RSS feeds)
-- ---------------------------------------------------------------------------
create table if not exists public.sources (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  rss_url       text not null unique,
  department_id uuid not null references public.departments(id) on delete restrict,
  active        boolean not null default true,
  place         text,                          -- where the source is based; shown on the news map
  lat           double precision check (lat between -90 and 90),
  lon           double precision check (lon between -180 and 180),
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- raw_items (one row per fetched feed entry)
-- ---------------------------------------------------------------------------
create table if not exists public.raw_items (
  id              uuid primary key default gen_random_uuid(),
  source_id       uuid not null references public.sources(id) on delete cascade,
  url             text not null unique,
  title           text not null,
  content         text not null default '',    -- RSS summary/description
  full_text       text,                        -- extracted article text; INTERNAL ONLY, never displayed
  fetched_at      timestamptz not null default now(),
  status          text not null default 'new'
                    check (status in ('new', 'new-relevant', 'skipped', 'written', 'failed')),
  relevance_score int check (relevance_score between 0 and 10),
  department_id   uuid references public.departments(id) on delete set null,
  source_published_at timestamptz,             -- from the feed's pubDate; null if the feed gave none
  classify_reason text                         -- LLM reason, or 'no_keyword_match' / 'too_old' / 'source_too_short'
);

-- For databases created before source_published_at existed.
alter table public.raw_items add column if not exists source_published_at timestamptz;

create index if not exists raw_items_status_idx on public.raw_items (status, fetched_at);

-- ---------------------------------------------------------------------------
-- articles
-- ---------------------------------------------------------------------------
create table if not exists public.articles (
  id               uuid primary key default gen_random_uuid(),
  raw_item_id      uuid unique references public.raw_items(id) on delete set null,
  slug             text not null unique,
  headline         text not null,
  body             text not null,
  summary          text,                       -- first 240 characters of the body, for the feed cards (2026-10-18)
  source_urls      text[] not null default '{}',
  department_id    uuid references public.departments(id) on delete restrict, -- a department with articles cannot be deleted (2026-10-19)
  status           text not null default 'draft'
                     check (status in ('draft', 'rejected', 'pending_review', 'published')),
  fact_check_notes text,
  image_query      text,                       -- from the writer; used by the image stage
  image_url        text,
  image_credit     text,
  image_credit_url text,                       -- photographer page (Unsplash attribution; null for default images)
  image_alt        text,
  source_published_at timestamptz,             -- copied from the raw item; shown as 'Based on a source published ...'
  place            text,                       -- copied from the source when the draft is written
  lat              double precision check (lat between -90 and 90),
  lon              double precision check (lon between -180 and 180),
  created_at       timestamptz not null default now(),
  published_at     timestamptz
);

-- For databases created before source_published_at existed.
alter table public.articles add column if not exists source_published_at timestamptz;
-- For databases created before summary existed (the backfill is in the 2026-10-18 section at the end).
alter table public.articles add column if not exists summary text;

-- Map location (for databases created before these columns existed).
alter table public.sources  add column if not exists place text;
alter table public.sources  add column if not exists lat double precision check (lat between -90 and 90);
alter table public.sources  add column if not exists lon double precision check (lon between -180 and 180);
alter table public.articles add column if not exists place text;
alter table public.articles add column if not exists lat double precision check (lat between -90 and 90);
alter table public.articles add column if not exists lon double precision check (lon between -180 and 180);

create index if not exists articles_status_idx on public.articles (status, created_at);
create index if not exists articles_published_idx on public.articles (published_at desc)
  where status = 'published';

-- ---------------------------------------------------------------------------
-- agent_runs (one row per LLM call, including retries)
-- ---------------------------------------------------------------------------
create table if not exists public.agent_runs (
  id            uuid primary key default gen_random_uuid(),
  agent         text not null,                 -- classify | write | factcheck
  model         text not null,
  article_id    uuid references public.articles(id) on delete set null,
  raw_item_id   uuid references public.raw_items(id) on delete set null, -- classify/write run before an article exists
  input_tokens  int not null default 0,
  output_tokens int not null default 0,
  created_at    timestamptz not null default now()
);

create index if not exists agent_runs_created_idx on public.agent_runs (created_at);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- The service role bypasses RLS. anon/authenticated get only the policies below.
-- ---------------------------------------------------------------------------
alter table public.departments enable row level security;
alter table public.sources     enable row level security;
alter table public.raw_items   enable row level security;
alter table public.articles    enable row level security;
alter table public.agent_runs  enable row level security;

drop policy if exists "public reads published articles" on public.articles;
create policy "public reads published articles"
  on public.articles for select
  to anon, authenticated
  using (status = 'published');

-- Department names are shown as tags/filters on public pages. Drop this policy
-- if departments must stay private (the public pages would then need a view).
drop policy if exists "public reads departments" on public.departments;
create policy "public reads departments"
  on public.departments for select
  to anon, authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- World news column, country markers, review log and pipeline runs (2026-10-14).
-- Idempotent. The first block may already be applied.
-- ---------------------------------------------------------------------------
alter table public.departments add column if not exists kind text not null default 'company'
  check (kind in ('company', 'world'));
alter table public.sources  add column if not exists country_code text;   -- ISO-3166 alpha-2; fallback country for its articles
alter table public.articles add column if not exists country_code text;   -- where the event takes place (validated in app code)
alter table public.articles add column if not exists country_name text;

insert into public.departments (name, slug, description, kind, keywords)
values ('World', 'world', 'World news: factual, significant international events.', 'world', '{}')
on conflict (name) do update set kind = 'world';

create index if not exists articles_country_idx on public.articles (country_code) where status = 'published';

-- One row per admin approve / reject / unpublish (who, when, why).
create table if not exists public.review_log (
  id          uuid primary key default gen_random_uuid(),
  article_id  uuid references public.articles(id) on delete cascade,
  action      text not null check (action in ('approve', 'reject', 'unpublish')),
  actor_email text not null,
  reason      text,
  bulk        boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists review_log_article_idx on public.review_log (article_id, created_at desc);

-- One row per pipeline stage run (cron or admin "Run next batch").
create table if not exists public.pipeline_runs (
  id           uuid primary key default gen_random_uuid(),
  stage        text not null check (stage in ('ingest', 'classify', 'write', 'image', 'factcheck')),
  started_at   timestamptz not null,
  finished_at  timestamptz,                   -- null while the run is in progress: that row is the stage's lock (2026-10-19)
  ok           boolean,                       -- null while the run is in progress
  alert_sent   boolean not null default false, -- the run that triggered the 'failed twice in a row' email (2026-10-19)
  summary      jsonb,
  error        text,
  triggered_by text not null                  -- 'cron' or the admin's email
);
create index if not exists pipeline_runs_stage_idx on public.pipeline_runs (stage, started_at desc);

-- Service role only: no policies for anon/authenticated.
alter table public.review_log    enable row level security;
alter table public.pipeline_runs enable row level security;

-- ---------------------------------------------------------------------------
-- Recover rejected / skipped news (2026-10-15). Idempotent; run after the 2026-10-14 block.
-- ---------------------------------------------------------------------------
alter table public.articles   add column if not exists review_note text;   -- e.g. "Restored by editor, fact-check had flagged: ..."
alter table public.review_log add column if not exists raw_item_id uuid references public.raw_items(id) on delete set null;
alter table public.review_log add column if not exists previous_status text;
alter table public.review_log drop constraint if exists review_log_action_check;
alter table public.review_log add constraint review_log_action_check
  check (action in ('approve', 'reject', 'unpublish', 'restore', 'mark_relevant'));

-- ---------------------------------------------------------------------------
-- Weekly email digest (2026-10-16). Idempotent: if you already created these tables, the
-- "add column if not exists" lines bring them up to the shape the app uses.
-- ---------------------------------------------------------------------------
create table if not exists public.digests (
  id               uuid primary key default gen_random_uuid(),
  week_start       date not null unique,        -- Monday of the week in Asia/Kolkata: one digest per week
  status           text not null default 'draft'
                     check (status in ('draft', 'approved', 'sending', 'sent', 'failed', 'skipped')),
  subject          text not null default '',
  intro            text not null default '',
  lead_article_id  uuid references public.articles(id) on delete set null,
  article_ids      uuid[] not null default '{}', -- the stories in order; the first is the lead
  approved_by      text,
  approved_at      timestamptz,
  sent_at          timestamptz,
  error            text,                         -- why it failed, or why it was skipped
  recipient_count  int,
  reminder_sent_at timestamptz,                  -- "waiting for approval" reminder, sent at most once
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
alter table public.digests add column if not exists week_start date;
alter table public.digests add column if not exists status text not null default 'draft';
alter table public.digests add column if not exists subject text not null default '';
alter table public.digests add column if not exists intro text not null default '';
alter table public.digests add column if not exists lead_article_id uuid references public.articles(id) on delete set null;
alter table public.digests add column if not exists article_ids uuid[] not null default '{}';
alter table public.digests add column if not exists approved_by text;
alter table public.digests add column if not exists approved_at timestamptz;
alter table public.digests add column if not exists sent_at timestamptz;
alter table public.digests add column if not exists error text;
alter table public.digests add column if not exists recipient_count int;
alter table public.digests add column if not exists reminder_sent_at timestamptz;
alter table public.digests add column if not exists created_at timestamptz not null default now();
alter table public.digests add column if not exists updated_at timestamptz not null default now();
-- insertIfAbsent upserts on week_start, which needs a unique index on it.
create unique index if not exists digests_week_start_idx on public.digests (week_start);
alter table public.digests drop constraint if exists digests_status_check;
alter table public.digests add constraint digests_status_check
  check (status in ('draft', 'approved', 'sending', 'sent', 'failed', 'skipped'));

create table if not exists public.digest_recipients (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.digest_recipients add column if not exists email text;
alter table public.digest_recipients add column if not exists active boolean not null default true;
alter table public.digest_recipients add column if not exists created_at timestamptz not null default now();
-- Addresses are stored lower-case by the app; a plain unique index is what upsert (on_conflict) needs.
create unique index if not exists digest_recipients_email_idx on public.digest_recipients (email);

-- One row per admin action and per send batch. Never holds addresses.
create table if not exists public.digest_log (
  id         uuid primary key default gen_random_uuid(),
  digest_id  uuid references public.digests(id) on delete cascade,
  action     text not null,
  actor      text not null,                      -- admin email, or 'cron'
  detail     jsonb,
  created_at timestamptz not null default now()
);
alter table public.digest_log add column if not exists digest_id uuid references public.digests(id) on delete cascade;
alter table public.digest_log add column if not exists action text not null default '';
alter table public.digest_log add column if not exists actor text not null default '';
alter table public.digest_log add column if not exists detail jsonb;
alter table public.digest_log add column if not exists created_at timestamptz not null default now();
create index if not exists digest_log_digest_idx on public.digest_log (digest_id, created_at desc);

-- Service role only: no policies for anon/authenticated.
alter table public.digests           enable row level security;
alter table public.digest_recipients enable row level security;
alter table public.digest_log        enable row level security;

-- ---------------------------------------------------------------------------
-- Align tables that were created from different SQL with what the code writes.
-- Only relaxes constraints and sets defaults; no table, column or row is dropped.
-- ---------------------------------------------------------------------------
-- The code writes NULL to these (a new draft has no approver, a skipped one no lead story, ...).
alter table public.digests alter column lead_article_id  drop not null;
alter table public.digests alter column approved_by      drop not null;
alter table public.digests alter column approved_at      drop not null;
alter table public.digests alter column sent_at          drop not null;
alter table public.digests alter column error            drop not null;
alter table public.digests alter column recipient_count  drop not null;
alter table public.digests alter column reminder_sent_at drop not null;
alter table public.digest_log alter column digest_id     drop not null;  -- recipient changes belong to no digest
alter table public.digest_log alter column detail        drop not null;

-- Defaults the code relies on (recipients are inserted with the email alone).
alter table public.digests alter column status     set default 'draft';
alter table public.digests alter column subject    set default '';
alter table public.digests alter column intro      set default '';
alter table public.digests alter column article_ids set default '{}';
alter table public.digests alter column created_at set default now();
alter table public.digests alter column updated_at set default now();
alter table public.digest_recipients alter column active     set default true;
alter table public.digest_recipients alter column created_at set default now();
alter table public.digest_log alter column created_at set default now();

do $$
declare r record;
begin
  -- uuid ids get a generated default, since the code never supplies one.
  for r in
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'id' and data_type = 'uuid'
      and table_name in ('digests', 'digest_recipients', 'digest_log')
  loop
    execute format('alter table public.%I alter column id set default gen_random_uuid()', r.table_name);
  end loop;

  -- Any other column the code never writes must not block an insert: drop NOT NULL on extras without a default.
  for r in
    select c.table_name, c.column_name from information_schema.columns c
    where c.table_schema = 'public' and c.is_nullable = 'NO' and c.column_default is null
      and (c.table_name, c.column_name) not in (
        ('digests', 'id'), ('digests', 'week_start'),
        ('digest_recipients', 'id'), ('digest_recipients', 'email'),
        ('digest_log', 'id'), ('digest_log', 'action'), ('digest_log', 'actor'))
      and c.table_name in ('digests', 'digest_recipients', 'digest_log')
  loop
    execute format('alter table public.%I alter column %I drop not null', r.table_name, r.column_name);
  end loop;
end $$;
-- Make PostgREST pick up the new columns now.
notify pgrst, 'reload schema';

-- ===========================================================================
-- AI & Technology and employee submissions (2026-10-15). Same as supabase/migrations/2026-10-15-ai-tech-and-submissions.sql.
-- Needs the default postgres role (it writes to storage.buckets and storage.objects policies).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. AI & Technology department (company news) and its feeds
-- ---------------------------------------------------------------------------
alter table public.departments add column if not exists kind text not null default 'company'
  check (kind in ('company', 'world'));

insert into public.departments (name, slug, description, kind, keywords)
values (
  'AI & Technology',
  'ai-technology',
  'Artificial intelligence and machine learning, LLMs and generative AI, AI regulation and safety, robotics and automation, semiconductors and AI chips, cloud and data-center technology, and cybersecurity.',
  'company',
  array['artificial intelligence','ai','machine learning','deep learning','neural network','llm','llms','large language model','generative ai','genai','chatgpt','openai','anthropic','claude','gemini','copilot','foundation model','ai agent','agentic','ai regulation','ai safety','ai act','robot','robots','robotics','humanoid','automation','semiconductor','semiconductors','chip','chips','gpu','gpus','nvidia','tsmc','data center','data centre','cloud','cybersecurity','ransomware','vulnerability','data breach']
)
on conflict do nothing;

-- Keeps the description and keywords in step with the code (lib/config.ts AI_TECH_DESCRIPTION). Re-running this resets them.
update public.departments
set description = 'Artificial intelligence and machine learning, LLMs and generative AI, AI regulation and safety, robotics and automation, semiconductors and AI chips, cloud and data-center technology, and cybersecurity.',
    kind = 'company',
    keywords = array['artificial intelligence','ai','machine learning','deep learning','neural network','llm','llms','large language model','generative ai','genai','chatgpt','openai','anthropic','claude','gemini','copilot','foundation model','ai agent','agentic','ai regulation','ai safety','ai act','robot','robots','robotics','humanoid','automation','semiconductor','semiconductors','chip','chips','gpu','gpus','nvidia','tsmc','data center','data centre','cloud','cybersecurity','ransomware','vulnerability','data breach']
where slug = 'ai-technology';

-- Feeds checked on 2026-10-15: HTTP 200 and valid RSS/Atom with items from the last two days.
-- (VentureBeat answered 429 to the newsroom's User-Agent, so it is not seeded.)
-- country_code stays null: these are global publishers; the write agent supplies the story's country.
insert into public.sources (name, rss_url, department_id, active)
select s.name, s.rss_url, d.id, true
from (values
  ('MIT Technology Review - AI',  'https://www.technologyreview.com/topic/artificial-intelligence/feed'),
  ('The Verge - AI',              'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml'),
  ('Ars Technica - Technology Lab','https://feeds.arstechnica.com/arstechnica/technology-lab'),
  ('IEEE Spectrum - AI',          'https://spectrum.ieee.org/feeds/topic/artificial-intelligence.rss'),
  ('Google - AI blog',            'https://blog.google/innovation-and-ai/technology/ai/rss/'),
  ('TechCrunch - AI',             'https://techcrunch.com/category/artificial-intelligence/feed/')
) as s(name, rss_url)
cross join (select id from public.departments where slug = 'ai-technology') d
on conflict (rss_url) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Who wrote an article: new columns on articles (existing rows are AI articles)
-- ---------------------------------------------------------------------------
alter table public.articles add column if not exists origin text not null default 'ai';
alter table public.articles drop constraint if exists articles_origin_check;
alter table public.articles add constraint articles_origin_check check (origin in ('ai', 'employee'));
alter table public.articles add column if not exists author_first_name text;
alter table public.articles add column if not exists author_last_name text;
alter table public.articles add column if not exists author_department text;   -- the author's own company department
alter table public.articles drop constraint if exists articles_employee_author_check;
alter table public.articles add constraint articles_employee_author_check
  check (origin <> 'employee' or (author_first_name is not null and author_last_name is not null));
create index if not exists articles_origin_idx on public.articles (origin) where status = 'pending_review';

-- ---------------------------------------------------------------------------
-- 3. Private table for the submitter's details. Not readable by anon or authenticated, ever:
--    RLS is on with no policy, and the table privileges are revoked as well.
-- ---------------------------------------------------------------------------
create table if not exists public.article_submitters (
  article_id     uuid primary key references public.articles(id) on delete cascade,
  email          text not null,
  ip_hash        text,                                  -- keyed hash of the network address; the raw IP is never stored
  email_verified boolean not null default false,        -- true: the domain matched ALLOWED_EMAIL_DOMAINS when it was sent
  submitted_at   timestamptz not null default now(),
  image_path     text                                   -- object in the private submission-images bucket, if a photo was sent
);
alter table public.article_submitters add column if not exists email text;
alter table public.article_submitters add column if not exists ip_hash text;
alter table public.article_submitters add column if not exists email_verified boolean not null default false;
alter table public.article_submitters add column if not exists submitted_at timestamptz not null default now();
alter table public.article_submitters add column if not exists image_path text;
create index if not exists article_submitters_ip_idx    on public.article_submitters (ip_hash, submitted_at desc);
create index if not exists article_submitters_email_idx on public.article_submitters (email, submitted_at desc);

alter table public.article_submitters enable row level security;   -- no policies: only the service role gets in
revoke all on public.article_submitters from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Storage: a private bucket for photos waiting for review, a public one for published photos
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('submission-images', 'submission-images', false, 5242880, array['image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('article-images', 'article-images', true, 5242880, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- submission-images: no policy at all for anon or authenticated, so only the service role (the server) can
-- upload, read or sign URLs for it. article-images: anyone may read; nobody but the service role may write.
drop policy if exists "public reads published article images" on storage.objects;
create policy "public reads published article images"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'article-images');

-- ---------------------------------------------------------------------------
-- 5. Make the API pick up the new columns and tables now
-- ---------------------------------------------------------------------------
notify pgrst, 'reload schema';

-- ===========================================================================
-- Security and indexes (2026-10-17). Same as supabase/migrations/2026-10-17_security_and_indexes.sql.
-- ===========================================================================

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
-- The grant names the block columns of the 2026-10-22 section, so on a new, empty database they must exist first
-- (their constraints are added in that section; these lines change nothing where the columns already exist).
alter table public.articles add column if not exists body_blocks jsonb;
alter table public.articles add column if not exists body_format text not null default 'plain';
revoke select on public.articles from anon, authenticated;
grant select (
  id, slug, headline, body, summary, place, lat, lon, country_code, country_name, source_urls,
  source_published_at, published_at, image_url, image_credit, image_credit_url, image_alt,
  origin, author_first_name, author_last_name, author_department,
  body_blocks, body_format,
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

-- ===========================================================================
-- Article summary (2026-10-18). Same as supabase/migrations/2026-10-18_article_summary.sql. The column and the grant
-- are above (create table / alter table / grant select); this is the backfill of rows that have no summary yet.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Backfill existing rows (only the ones without a summary yet). Same rule as makeSummary() in
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

notify pgrst, 'reload schema';

-- ===========================================================================
-- Reliability (2026-10-19). Same as supabase/migrations/2026-10-19_reliability.sql.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. BE-05 / BE-06: pipeline_runs is also the lock that stops a stage running twice at once.
--    A row with no finished_at is a run in progress; the partial unique index allows one per stage, so of two
--    simultaneous starts (cron and the admin button) the database lets exactly one in. The app closes a run that is
--    older than 10 minutes and never finished. alert_sent marks the run that triggered the "failed twice in a row" email.
-- ---------------------------------------------------------------------------
alter table public.pipeline_runs alter column finished_at drop not null;
alter table public.pipeline_runs alter column ok          drop not null;
alter table public.pipeline_runs add column if not exists alert_sent boolean not null default false;
create unique index if not exists pipeline_runs_one_running_idx on public.pipeline_runs (stage) where finished_at is null;

-- ---------------------------------------------------------------------------
-- 2. BE-04: when an admin raises today's AI spend limit. One row per raise, never updated: this is the log.
--    `day` is the Asia/Kolkata calendar day; the highest limit of the day is the one in force.
-- ---------------------------------------------------------------------------
create table if not exists public.budget_overrides (
  id                 uuid primary key default gen_random_uuid(),
  day                date not null,
  limit_usd          numeric(10, 2) not null check (limit_usd > 0),
  previous_limit_usd numeric(10, 2),
  raised_by          text not null,                  -- the admin's email
  created_at         timestamptz not null default now()
);
create index if not exists budget_overrides_day_idx on public.budget_overrides (day, limit_usd desc);
-- Service role only: no policies for anon/authenticated.
alter table public.budget_overrides enable row level security;

-- ---------------------------------------------------------------------------
-- 3. DB-03: retention. Called by /api/cron/cleanup and `npm run stage -- cleanup`.
--      a. raw_items.full_text is set to null once the item is written or skipped and older than p_full_text_days;
--      b. raw_items older than p_raw_item_days that have no article are deleted;
--      c. agent_runs and pipeline_runs older than p_run_months months are deleted.
--    p_apply = false (the default) changes nothing and returns what an apply would touch.
--    Returns {"apply", "full_text_cleared", "raw_items_deleted", "agent_runs_deleted", "pipeline_runs_deleted"}.
--    Every foreign key to raw_items is `on delete set null`, so deleting an item never fails on a reference.
-- ---------------------------------------------------------------------------
create or replace function public.run_retention(
  p_apply          boolean     default false,
  p_full_text_days int         default 14,
  p_raw_item_days  int         default 90,
  p_run_months     int         default 12,
  p_now            timestamptz default now()
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_text_cut timestamptz;
  v_raw_cut  timestamptz;
  v_run_cut  timestamptz;
  v_text     int;
  v_raw      int;
  v_agent    int;
  v_pipe     int;
begin
  if p_full_text_days < 1 or p_raw_item_days < 1 or p_run_months < 1 then
    raise exception 'retention periods must be at least 1';
  end if;
  v_text_cut := p_now - make_interval(days => p_full_text_days);
  v_raw_cut  := p_now - make_interval(days => p_raw_item_days);
  v_run_cut  := p_now - make_interval(months => p_run_months);

  if p_apply then
    update public.raw_items
    set full_text = null
    where full_text is not null and status in ('written', 'skipped') and fetched_at < v_text_cut;
    get diagnostics v_text = row_count;

    delete from public.raw_items r
    where r.fetched_at < v_raw_cut
      and not exists (select 1 from public.articles a where a.raw_item_id = r.id);
    get diagnostics v_raw = row_count;

    delete from public.agent_runs where created_at < v_run_cut;
    get diagnostics v_agent = row_count;

    delete from public.pipeline_runs where started_at < v_run_cut;
    get diagnostics v_pipe = row_count;
  else
    select count(*) into v_text from public.raw_items
    where full_text is not null and status in ('written', 'skipped') and fetched_at < v_text_cut;

    select count(*) into v_raw from public.raw_items r
    where r.fetched_at < v_raw_cut
      and not exists (select 1 from public.articles a where a.raw_item_id = r.id);

    select count(*) into v_agent from public.agent_runs where created_at < v_run_cut;
    select count(*) into v_pipe  from public.pipeline_runs where started_at < v_run_cut;
  end if;

  return jsonb_build_object(
    'apply', p_apply,
    'full_text_cleared', v_text,
    'raw_items_deleted', v_raw,
    'agent_runs_deleted', v_agent,
    'pipeline_runs_deleted', v_pipe
  );
end;
$$;

-- Only the service role (the app's server code) may run it: it deletes rows.
revoke all on function public.run_retention(boolean, int, int, int, timestamptz) from public, anon, authenticated;
grant execute on function public.run_retention(boolean, int, int, int, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 4. DB-05: deleting a department that still has articles is refused, instead of silently leaving them without one.
--    (Finds the existing constraint whatever it is called, drops it and adds it again with `on delete restrict`.)
-- ---------------------------------------------------------------------------
do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
    where con.conrelid = 'public.articles'::regclass
      and con.contype = 'f'
      and con.confrelid = 'public.departments'::regclass
      and att.attname = 'department_id'
  loop
    execute format('alter table public.articles drop constraint %I', c.conname);
  end loop;
  alter table public.articles
    add constraint articles_department_id_fkey
    foreign key (department_id) references public.departments (id) on delete restrict;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Make the API pick up the new column, table and function now
-- ---------------------------------------------------------------------------
notify pgrst, 'reload schema';

-- ===========================================================================
-- Privacy and hardening (2026-10-20). Same as supabase/migrations/2026-10-20_privacy_and_hardening.sql.
-- ===========================================================================

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

-- ===========================================================================
-- Story blocks, likes and comments (2026-10-22). Same as supabase/migrations/2026-10-22_story_blocks.sql. The public column grant on
-- articles (body_blocks, body_format) is in the grant statement near the top of this file.
-- ===========================================================================
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
