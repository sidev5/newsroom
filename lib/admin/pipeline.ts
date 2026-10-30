import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { STAGE_ORDER, runStage, type StageName } from "@/lib/pipeline/stages";
import { currentAdminEmail } from "./session";
import { ARTICLE_STATUSES, RAW_STATUSES } from "./review-view";

// ---------------------------------------------------------------------------
// Run next batch (admin only; the browser never sees the cron secret)
// ---------------------------------------------------------------------------

export type StageOutcome = { stage: StageName; ok: boolean; summary?: unknown; error?: string };

export type BatchResult = { ok: true; stages: StageOutcome[] } | { ok: false; error: string };

const defaultBatchDeps: BatchDeps = {
  adminEmail: currentAdminEmail,
  // An admin run is one chunk per stage (STAGE_CHUNK_SIZE items), so it fits in one request and shows progress.
  runStage: (stage, by) => runStage(stage, by, { options: { limit: env().STAGE_CHUNK_SIZE } }),
};

export type BatchDeps = {
  adminEmail: () => Promise<string | null>;
  /** Runs one stage and records it; called with the admin's email as the trigger. */
  runStage: (stage: StageName, triggeredBy: string) => Promise<unknown>;
};

/**
 * Runs ingest, classify, write, image and factcheck once, in that order, server-side. Each stage
 * handles one chunk (STAGE_CHUNK_SIZE items). A stage that throws is reported
 * and the next one still runs, since later stages work on rows that already exist.
 */
export async function runNextBatch(deps: BatchDeps = defaultBatchDeps): Promise<BatchResult> {
  const admin = await deps.adminEmail();
  if (!admin) return { ok: false, error: "Not authorised." };

  const stages: StageOutcome[] = [];
  for (const stage of STAGE_ORDER) stages.push(await runAs(stage, admin, deps));
  return { ok: true, stages };
}

async function runAs(stage: StageName, admin: string, deps: BatchDeps): Promise<StageOutcome> {
  try {
    return { stage, ok: true, summary: await deps.runStage(stage, admin) };
  } catch (err) {
    return { stage, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** One stage, one chunk, for the Pipeline tab's progress button. Admin check first. */
export async function runOneStage(
  stage: StageName,
  deps: BatchDeps = defaultBatchDeps,
): Promise<{ ok: true; outcome: StageOutcome } | { ok: false; error: string }> {
  const admin = await deps.adminEmail();
  if (!admin) return { ok: false, error: "Not authorised." };
  return { ok: true, outcome: await runAs(stage, admin, deps) };
}

// ---------------------------------------------------------------------------
// Overview for the Pipeline tab
// ---------------------------------------------------------------------------

export type LastRun = {
  stage: StageName;
  finished_at: string;
  ok: boolean;
  error: string | null;
  summary: unknown;
  triggered_by: string;
};

export type DroppedItem = {
  id: string;
  title: string;
  status: string;
  reason: string | null;
  source: string | null;
  fetched_at: string;
};

/** A run in progress: the stage's lock. */
export type RunningRun = { stage: StageName; started_at: string; triggered_by: string };

export type PipelineOverview = {
  raw: Record<string, number>;
  articles: Record<string, number>;
  lastRuns: Partial<Record<StageName, LastRun>>;
  running: Partial<Record<StageName, RunningRun>>;
  dropped: DroppedItem[];
  /** Set when a query failed (e.g. a table that has not been created yet), so the tab can say so. */
  warnings: string[];
};

async function countStatus(table: "raw_items" | "articles", status: string): Promise<number> {
  const { count, error } = await supabaseAdmin().from(table).select("*", { count: "exact", head: true }).eq("status", status);
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

export async function getPipelineOverview(): Promise<PipelineOverview> {
  const db = supabaseAdmin();
  const warnings: string[] = [];
  const guard = async <T>(label: string, fallback: T, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      warnings.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      return fallback;
    }
  };

  const [raw, articles, lastRuns, running, dropped] = await Promise.all([
    guard("raw_items counts", {} as Record<string, number>, async () =>
      Object.fromEntries(await Promise.all(RAW_STATUSES.map(async (s) => [s, await countStatus("raw_items", s)] as const))),
    ),
    guard("articles counts", {} as Record<string, number>, async () =>
      Object.fromEntries(await Promise.all(ARTICLE_STATUSES.map(async (s) => [s, await countStatus("articles", s)] as const))),
    ),
    guard("last runs (has supabase/migrations/2026-10-14_world_review_pipeline.sql been applied?)", {} as PipelineOverview["lastRuns"], async () => {
      const entries = await Promise.all(
        STAGE_ORDER.map(async (stage) => {
          const { data, error } = await db
            .from("pipeline_runs")
            .select("stage, finished_at, ok, error, summary, triggered_by")
            .eq("stage", stage)
            .not("finished_at", "is", null) // a run in progress is shown separately
            .order("started_at", { ascending: false })
            .limit(1);
          if (error) throw new Error(error.message);
          return [stage, (data?.[0] as LastRun | undefined) ?? undefined] as const;
        }),
      );
      return Object.fromEntries(entries.filter(([, run]) => run)) as PipelineOverview["lastRuns"];
    }),
    guard("runs in progress", {} as PipelineOverview["running"], async () => {
      const { data, error } = await db.from("pipeline_runs").select("stage, started_at, triggered_by").is("finished_at", null);
      if (error) throw new Error(error.message);
      return Object.fromEntries(((data ?? []) as RunningRun[]).map((r) => [r.stage, r])) as PipelineOverview["running"];
    }),
    guard("dropped items", [] as DroppedItem[], async () => {
      const { data, error } = await db
        .from("raw_items")
        .select("id, title, status, classify_reason, fetched_at, sources(name)")
        .in("status", ["skipped", "failed"])
        .order("fetched_at", { ascending: false })
        .limit(25);
      if (error) throw new Error(error.message);
      type Row = { id: string; title: string; status: string; classify_reason: string | null; fetched_at: string; sources: { name: string } | { name: string }[] | null };
      return ((data ?? []) as unknown as Row[]).map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        reason: r.classify_reason,
        source: (Array.isArray(r.sources) ? r.sources[0]?.name : r.sources?.name) ?? null,
        fetched_at: r.fetched_at,
      }));
    }),
  ]);

  return { raw, articles, lastRuns, running, dropped, warnings };
}
