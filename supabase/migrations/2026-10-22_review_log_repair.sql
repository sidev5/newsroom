-- Run in the Supabase SQL editor. Safe to re-run.
--
-- Repairs public.review_log on a database that never received 2026-10-15_recover_rejected_skipped.sql: the audit-log writes of
-- "restore" and "mark_relevant" (single and bulk) failed with a missing column (previous_status, raw_item_id) or with
-- review_log_action_check. It is the same statements as that file, on their own, so it can be run without anything else.
-- It needs public.review_log (2026-10-14_world_review_pipeline.sql) and public.raw_items to exist.

-- Columns the code writes (lib/admin/review.ts, lib/admin/recover.ts) beyond the original table.
alter table public.review_log add column if not exists raw_item_id uuid references public.raw_items(id) on delete set null; -- mark_relevant: the raw item that was changed
alter table public.review_log add column if not exists previous_status text;                                              -- restore, mark_relevant: the status it had before

-- Every action value the code writes.
alter table public.review_log drop constraint if exists review_log_action_check;
alter table public.review_log add constraint review_log_action_check
  check (action in ('approve', 'reject', 'unpublish', 'restore', 'mark_relevant'));

notify pgrst, 'reload schema';
