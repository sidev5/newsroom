import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { STALE_RUN_NOTE, type RecentRun, type RunHandle, type RunRecord, type RunStore } from "./run-log";

const UNIQUE_VIOLATION = "23505";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** pipeline_runs in Supabase. Bookkeeping never fails a stage: when the table cannot be used the stage runs unlocked. */
export function supabaseRunStore(): RunStore {
  return {
    async acquire(stage, triggeredBy, startedAt, staleMs) {
      const db = supabaseAdmin();
      const started = startedAt.toISOString();
      try {
        // A run that never finished, longer ago than the stale timeout, no longer holds the stage.
        await db
          .from("pipeline_runs")
          .update({ finished_at: started, ok: false, error: STALE_RUN_NOTE })
          .eq("stage", stage)
          .is("finished_at", null)
          .lt("started_at", new Date(startedAt.getTime() - staleMs).toISOString());

        // The partial unique index (one row per stage with no finished_at) decides who wins a race.
        const { data, error } = await db
          .from("pipeline_runs")
          .insert({ stage, started_at: started, finished_at: null, ok: null, summary: null, error: null, triggered_by: triggeredBy })
          .select("id")
          .single();
        if (!error) return { ok: true as const, handle: { id: (data as { id: string }).id } };

        if (error.code === UNIQUE_VIOLATION) {
          const { data: holder } = await db
            .from("pipeline_runs")
            .select("started_at, triggered_by")
            .eq("stage", stage)
            .is("finished_at", null)
            .limit(1);
          const row = (holder ?? [])[0] as { started_at: string; triggered_by: string } | undefined;
          return { ok: false as const, startedAt: row?.started_at ?? started, triggeredBy: row?.triggered_by ?? "another run" };
        }
        // Anything else (for example the 2026-10-19 migration has not been run, so finished_at is NOT NULL):
        // run without the lock and store the outcome as before.
        console.error(`locking ${stage} failed, running without a lock: ${error.message}`);
      } catch (err) {
        console.error(`locking ${stage} failed, running without a lock: ${errorText(err)}`);
      }
      return { ok: true as const, handle: { id: null } };
    },

    async finish(handle: RunHandle, record: RunRecord) {
      const db = supabaseAdmin();
      try {
        if (handle.id) {
          const { data, error } = await db
            .from("pipeline_runs")
            .update({ finished_at: record.finished_at, ok: record.ok, summary: record.summary, error: record.error })
            .eq("id", handle.id)
            .select("id");
          if (error) throw new Error(error.message);
          if (data && data.length > 0) return handle.id;
        }
        const { data, error } = await db.from("pipeline_runs").insert(record).select("id").single();
        if (error) throw new Error(error.message);
        return (data as { id: string }).id;
      } catch (err) {
        console.error(`recording ${record.stage} run failed: ${errorText(err)}`);
        return null;
      }
    },

    async recent(stage, limit) {
      const { data, error } = await supabaseAdmin()
        .from("pipeline_runs")
        .select("id, ok, error, finished_at, alert_sent")
        .eq("stage", stage)
        .not("finished_at", "is", null)
        .order("started_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      return ((data ?? []) as { id: string; ok: boolean | null; error: string | null; finished_at: string; alert_sent: boolean | null }[]).map(
        (r): RecentRun => ({ id: r.id, ok: r.ok === true, error: r.error, finished_at: r.finished_at, alert_sent: r.alert_sent === true }),
      );
    },

    async markAlerted(id) {
      const { error } = await supabaseAdmin().from("pipeline_runs").update({ alert_sent: true }).eq("id", id);
      if (error) throw new Error(error.message);
    },
  };
}
