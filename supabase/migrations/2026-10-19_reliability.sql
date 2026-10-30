-- Run in the Supabase SQL editor (as the default `postgres` role). Idempotent: safe to run again.
-- Same statements as the "Reliability (2026-10-19)" section at the end of schema.sql.
-- Run it after 2026-10-18_article_summary.sql. The app keeps working before it is run (a stage then runs without its
-- lock, and the daily limit cannot be raised), but nothing in it can be used until it has been.

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
