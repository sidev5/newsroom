import "server-only";
import { STAGE_LOCK_STALE_MS } from "@/lib/config";
import { env } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { pipelineAlertMail, pipelineLink } from "./alert-mail";
import type { StageOptions } from "./chunks";
import { runClassify } from "./classify";
import { runFactcheck } from "./factcheck";
import { runImage } from "./image";
import { runIngest } from "./ingest";
import { alertOnRepeatedFailure, StageBusyError, type AlertMail, type RunHandle, type RunRecord, type RunStore } from "./run-log";
import { supabaseRunStore } from "./run-store";
import type { StageName } from "./stage-names";
import { runWrite } from "./write";

export { STAGE_ORDER, isStageName, type StageName } from "./stage-names";
export { StageBusyError, type RunRecord } from "./run-log";

/** What every stage reports after a call, whatever its own result looks like. */
export type StageProgress = {
  /** Items the stage finished with in this call (ingest: items stored). */
  processed: number;
  /** Items still waiting in the stage's queue (ingest: new items left over the per-feed cap). */
  remaining: number;
  /** The provider returned 429 and the stage stopped (or, for images, stopped fetching photos). */
  rateLimited: boolean;
  /** Dropped on purpose: classify/write skipped, fact-check rejected, ingest too old. */
  rejected: number;
  failed: number;
  /** budget_exceeded: the daily spend cap is reached; the items stay queued. */
  stopped: "rate_limited" | "provider_error" | "time_budget" | "budget_exceeded" | null;
  /** Why the provider stopped the stage: HTTP status and message, keys removed. Null when it did not. */
  stoppedError: string | null;
};

type Raw = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Pure: maps one stage's own result to StageProgress. `queue` is the live queue size when known. */
export function progressOf(stage: StageName, raw: Raw, queue: number | null = null): StageProgress {
  const stopped = (raw.stopped as StageProgress["stopped"]) ?? null;
  const rateLimited = stopped === "rate_limited" || raw.rateLimited === true;
  const stoppedError = typeof raw.stoppedError === "string" && raw.stoppedError ? raw.stoppedError : null;

  if (stage === "ingest") {
    const t = (raw.totals ?? {}) as Raw;
    return {
      processed: num(t.inserted),
      remaining: num(t.deferred),
      rateLimited: false,
      rejected: num(t.tooOld),
      failed: num(t.failed),
      stopped: stopped === "time_budget" ? "time_budget" : null,
      stoppedError: null,
    };
  }
  const rejected = stage === "factcheck" ? num(raw.rejected) : stage === "image" ? 0 : num(raw.skipped);
  return {
    processed: num(raw.processed),
    // Fall back to the items the stage itself left behind if the queue could not be counted.
    remaining: queue ?? num(raw.unprocessed),
    rateLimited,
    rejected,
    failed: num(raw.failed),
    stopped,
    stoppedError,
  };
}

/** The provider error a finished stage reports in its summary, if any: kept in pipeline_runs.error of the (ok) run. */
export function stoppedErrorOf(summary: unknown): string | null {
  const s = summary as Raw | null;
  return s && typeof s === "object" && typeof s.stoppedError === "string" && s.stoppedError ? s.stoppedError : null;
}

async function headCount(query: PromiseLike<{ count: number | null; error: unknown }>): Promise<number | null> {
  try {
    const { count, error } = await query;
    return error ? null : (count ?? 0);
  } catch {
    return null;
  }
}

/** Live size of a stage's queue, or null for ingest or if the count fails. */
export async function queueSize(stage: StageName): Promise<number | null> {
  const db = supabaseAdmin();
  const head = { count: "exact" as const, head: true };
  switch (stage) {
    case "classify":
      return headCount(db.from("raw_items").select("*", head).eq("status", "new"));
    case "write":
      return headCount(db.from("raw_items").select("*", head).eq("status", "new-relevant"));
    case "image":
      return headCount(db.from("articles").select("*", head).eq("status", "draft").is("image_url", null));
    case "factcheck":
      return headCount(db.from("articles").select("*", head).eq("status", "draft").not("image_url", "is", null));
    default:
      return null;
  }
}
type Runner = (opts: StageOptions) => Promise<unknown>;

/** Time-limited: a stage stops starting new items STAGE_TIME_BUDGET_MS after the call began. */
function withBudget(opts: StageOptions): StageOptions {
  return { ...opts, deadlineAt: opts.deadlineAt ?? Date.now() + env().STAGE_TIME_BUDGET_MS };
}

async function finish(stage: StageName, raw: Raw): Promise<Raw & StageProgress> {
  return { ...raw, ...progressOf(stage, raw, await queueSize(stage)) };
}

export const STAGE_RUNNERS: Record<StageName, Runner> = {
  // BE-01: ingest stops starting feeds and pages at the same deadline as the other stages, and reports what it left.
  ingest: async (opts) => finish("ingest", (await runIngest({ deadlineAt: withBudget(opts).deadlineAt })) as unknown as Raw),
  classify: async (opts) => finish("classify", (await runClassify({}, withBudget(opts))) as unknown as Raw),
  write: async (opts) => finish("write", (await runWrite({}, withBudget(opts))) as unknown as Raw),
  image: async (opts) => {
    const report = { rateLimited: false };
    const counts = await runImage({}, withBudget(opts), report);
    return finish("image", { ...counts, rateLimited: report.rateLimited });
  },
  factcheck: async (opts) => finish("factcheck", (await runFactcheck({}, withBudget(opts))) as unknown as Raw),
};

/** A store that only records outcomes, with no lock and no history: for callers that bring their own `save`. */
function saveOnlyStore(save: (r: RunRecord) => Promise<void>): RunStore {
  return {
    acquire: async () => ({ ok: true, handle: { id: null } }),
    finish: async (_handle: RunHandle, record) => {
      await save(record);
      return null;
    },
    recent: async () => [],
    markAlerted: async () => {},
  };
}

export type RunStageDeps = {
  run?: Runner;
  /** Limits this call (the admin button passes one chunk); a cron call uses BATCH_LIMIT. */
  options?: StageOptions;
  store?: RunStore;
  /** Records the outcome only (no lock, no failure alerts). Kept for tests; `store` is the full thing. */
  save?: (r: RunRecord) => Promise<void>;
  now?: () => Date;
  /** The email for repeated failures: null (or an address-less setup) means banner only. */
  alertMail?: () => AlertMail | null;
};

/**
 * Runs one stage and records when it ran, so the admin Pipeline tab can show the last run.
 *
 * BE-05: the stage is claimed first (a "running" row in pipeline_runs; the database allows one per stage), so cron and
 * the admin button cannot run the same stage at once: the second gets a StageBusyError and nothing runs. A run that
 * never finished stops blocking after STAGE_LOCK_STALE_MS.
 * BE-06: when the run fails and the stage has now failed twice in a row, one alert email goes to the admins.
 */
export async function runStage(stage: StageName, triggeredBy: string, deps: RunStageDeps = {}): Promise<unknown> {
  const run = deps.run ?? STAGE_RUNNERS[stage];
  const store = deps.store ?? (deps.save ? saveOnlyStore(deps.save) : supabaseRunStore());
  const now = deps.now ?? (() => new Date());

  const started = now();
  const lock = await store.acquire(stage, triggeredBy, started, STAGE_LOCK_STALE_MS);
  if (!lock.ok) throw new StageBusyError(stage, lock.startedAt, lock.triggeredBy);

  const started_at = started.toISOString();
  try {
    const summary = await run(deps.options ?? {});
    // A provider stop is not a failed run (the items stay queued, BE-06 alerts stay quiet), but its reason is kept in `error`.
    const stoppedError = stoppedErrorOf(summary);
    if (stoppedError) console.error(`${stage} stopped early: ${stoppedError}`);
    await store.finish(lock.handle, { stage, started_at, finished_at: now().toISOString(), ok: true, summary, error: stoppedError, triggered_by: triggeredBy });
    return summary;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const id = await store.finish(lock.handle, { stage, started_at, finished_at: now().toISOString(), ok: false, summary: null, error, triggered_by: triggeredBy });
    if (id) {
      await alertOnRepeatedFailure(stage, {
        store,
        mail: (deps.alertMail ?? pipelineAlertMail)(),
        link: pipelineLink(process.env.SITE_URL),
      });
    }
    throw err;
  }
}