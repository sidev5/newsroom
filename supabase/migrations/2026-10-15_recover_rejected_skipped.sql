-- Run in the Supabase SQL editor after 2026-10-14_world_review_pipeline.sql. Same statements as the end of schema.sql; safe to re-run.

-- ---------------------------------------------------------------------------
-- Recover rejected / skipped news (2026-10-15). Idempotent; run after the 2026-10-14 block.
-- ---------------------------------------------------------------------------
alter table public.articles   add column if not exists review_note text;   -- e.g. "Restored by editor, fact-check had flagged: ..."
alter table public.review_log add column if not exists raw_item_id uuid references public.raw_items(id) on delete set null;
alter table public.review_log add column if not exists previous_status text;
alter table public.review_log drop constraint if exists review_log_action_check;
alter table public.review_log add constraint review_log_action_check
  check (action in ('approve', 'reject', 'unpublish', 'restore', 'mark_relevant'));