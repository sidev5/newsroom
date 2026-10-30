-- Run in the Supabase SQL editor. Same statements as the end of schema.sql; safe to re-run.

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
  finished_at  timestamptz not null,
  ok           boolean not null,
  summary      jsonb,
  error        text,
  triggered_by text not null                  -- 'cron' or the admin's email
);
create index if not exists pipeline_runs_stage_idx on public.pipeline_runs (stage, started_at desc);

-- Service role only: no policies for anon/authenticated.
alter table public.review_log    enable row level security;
alter table public.pipeline_runs enable row level security;