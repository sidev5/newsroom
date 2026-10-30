import { FAILURE_ALERT_STREAK } from "@/lib/config";
import type { StageName } from "./stage-names";

// pipeline_runs is both the history the Pipeline tab shows and the lock that keeps one stage from running twice at
// once (BE-05): a row with no finished_at is a run in progress, and the database allows only one per stage. It also
// feeds the "failed twice in a row" banner and alert email (BE-06). Plain module: the rules are tested without a database.

export type RunRecord = {
  stage: StageName;
  started_at: string;
  finished_at: string;
  ok: boolean;
  summary: unknown;
  error: string | null;
  /** "cron", or the admin's email for a manual run. */
  triggered_by: string;
};

/** Where a started run is kept until it finishes. `id` is null when the lock could not be stored (old schema). */
export type RunHandle = { id: string | null };

export type AcquireResult = { ok: true; handle: RunHandle } | { ok: false; startedAt: string; triggeredBy: string };

/** A finished run, newest first in lists. */
export type RecentRun = { id: string; ok: boolean; error: string | null; finished_at: string; alert_sent: boolean };

export interface RunStore {
  /** Claims the stage for a run. A run that began more than `staleMs` ago and never finished is closed as failed first. */
  acquire(stage: StageName, triggeredBy: string, startedAt: Date, staleMs: number): Promise<AcquireResult>;
  /** Stores the outcome of the run `handle` stands for. Returns the id of the stored row. */
  finish(handle: RunHandle, record: RunRecord): Promise<string | null>;
  /** The latest finished runs of a stage, newest first. */
  recent(stage: StageName, limit: number): Promise<RecentRun[]>;
  markAlerted(id: string): Promise<void>;
}

/** Thrown instead of running a stage that is already running. */
export class StageBusyError extends Error {
  constructor(
    readonly stage: StageName,
    readonly startedAt: string,
    readonly triggeredBy: string,
  ) {
    super(`${stage} is already running (started ${startedAt.slice(0, 16).replace("T", " ")} UTC by ${triggeredBy}). Try again when it has finished.`);
    this.name = "StageBusyError";
  }
}

export const STALE_RUN_NOTE = "The run never reported back (the function was probably stopped); its lock was released after the stale timeout.";

// ---------------------------------------------------------------------------
// Failures in a row
// ---------------------------------------------------------------------------

export type FailureStreak = {
  stage: StageName;
  /** Runs in a row, counting back from the latest, that failed. */
  count: number;
  lastError: string | null;
  lastAt: string | null;
  /** An alert email was already sent for this streak. */
  alerted: boolean;
};

/** `runs` newest first. A run that finished ok ends the streak. */
export function failureStreak(stage: StageName, runs: RecentRun[]): FailureStreak {
  const failed: RecentRun[] = [];
  for (const run of runs) {
    if (run.ok) break;
    failed.push(run);
  }
  return {
    stage,
    count: failed.length,
    lastError: failed[0]?.error ?? null,
    lastAt: failed[0]?.finished_at ?? null,
    alerted: failed.some((r) => r.alert_sent),
  };
}

export const isRepeatedFailure = (s: FailureStreak) => s.count >= FAILURE_ALERT_STREAK;

/** One alert per streak: the second failure in a row sends it, the third and later do not, a success starts over. */
export const shouldAlert = (s: FailureStreak) => isRepeatedFailure(s) && !s.alerted;

export type AlertMail = { send(subject: string, text: string): Promise<void> };

export type AlertOutcome = "sent" | "not_needed" | "no_mail" | "send_failed";

export function alertText(s: FailureStreak, link: string): { subject: string; text: string } {
  return {
    subject: `Company Newsroom: ${s.stage} failed ${s.count} times in a row`,
    text:
      `The ${s.stage} stage of the newsroom pipeline has failed ${s.count} runs in a row.\n` +
      `Last error: ${(s.lastError ?? "unknown").slice(0, 300)}\n` +
      `Details: ${link}\n\nThis is the only email for this streak; the next one comes after a run succeeds and the stage fails twice again.\n`,
  };
}

/**
 * Called after a run of `stage` failed. When the stage has now failed twice in a row and nobody was told yet, sends
 * one email (when `mail` is available: otherwise the banner is all there is) and marks the run so a third failure
 * stays quiet. Never throws.
 */
export async function alertOnRepeatedFailure(
  stage: StageName,
  args: { store: Pick<RunStore, "recent" | "markAlerted">; mail: AlertMail | null; link: string; log?: (m: string) => void },
): Promise<AlertOutcome> {
  const log = args.log ?? console.error;
  try {
    const runs = await args.store.recent(stage, 20);
    const streak = failureStreak(stage, runs);
    if (!shouldAlert(streak)) return "not_needed";
    if (!args.mail) return "no_mail";
    const { subject, text } = alertText(streak, args.link);
    try {
      await args.mail.send(subject, text);
    } catch (err) {
      log(`alert email for ${stage} failed: ${err instanceof Error ? err.message : String(err)}`);
      return "send_failed";
    }
    await args.store.markAlerted(runs[0].id);
    return "sent";
  } catch (err) {
    log(`failure alert for ${stage} failed: ${err instanceof Error ? err.message : String(err)}`);
    return "send_failed";
  }
}
