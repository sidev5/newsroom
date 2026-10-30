-- Run in the Supabase SQL editor. Same statements as the end of schema.sql; safe to re-run.

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