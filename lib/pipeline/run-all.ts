// `npm run stage -- all`: drives the one-stage-per-call cron routes until each queue is empty.
// Plain module (no server-only imports) so the script and tests can use it.
import { STAGE_ORDER, type StageName } from "./stage-names";

/** What a stage route answers (see StageProgress in stages.ts). Fields may be missing on an error. */
export type StageBody = {
  processed?: number;
  remaining?: number;
  rateLimited?: boolean;
  rejected?: number;
  failed?: number;
  stopped?: string | null;
  /** The provider's error when it stopped the stage (status and message, keys removed). */
  stoppedError?: string | null;
};

export type StageCall = { ok: boolean; body: StageBody | null; error?: string };

export type StageOutcome = "done" | "rate-limited" | "stalled" | "max-calls" | "error";

export type StageSummary = {
  stage: StageName;
  calls: number;
  processed: number;
  remaining: number;
  rejected: number;
  failed: number;
  outcome: StageOutcome;
  error?: string;
};

export const DEFAULT_MAX_CALLS = 40;

/**
 * Runs ingest -> classify -> write -> image -> factcheck in order. Each stage is called repeatedly
 * until its queue is empty, it reports a rate limit, it makes no progress, or `maxCalls` is hit.
 * A rate-limited stage is not an error: its items stay queued for the next run.
 */
export async function runAll(
  callStage: (stage: StageName) => Promise<StageCall>,
  opts: { maxCalls?: number; pauseMs?: number; sleep?: (ms: number) => Promise<void>; onCall?: (stage: StageName, call: StageCall) => void } = {},
): Promise<StageSummary[]> {
  const maxCalls = opts.maxCalls ?? DEFAULT_MAX_CALLS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const summaries: StageSummary[] = [];

  for (const stage of STAGE_ORDER) {
    const s: StageSummary = { stage, calls: 0, processed: 0, remaining: 0, rejected: 0, failed: 0, outcome: "done" };
    summaries.push(s);

    for (;;) {
      const call = await callStage(stage);
      s.calls++;
      opts.onCall?.(stage, call);

      if (!call.ok || !call.body) {
        s.outcome = "error";
        s.error = call.error ?? "no response";
        break;
      }
      const b = call.body;
      s.processed += b.processed ?? 0;
      s.rejected += b.rejected ?? 0;
      s.failed += b.failed ?? 0;
      s.remaining = b.remaining ?? 0;
      // Shown in the result column whatever the outcome, so "stalled" says why.
      if (b.stoppedError) s.error = `${b.stopped ?? "stopped"}: ${b.stoppedError}`;

      if (b.rateLimited) {
        s.outcome = "rate-limited";
        break;
      }
      if (s.remaining === 0) break; // queue empty
      if ((b.processed ?? 0) === 0) {
        s.outcome = "stalled"; // items are waiting but nothing moved; another call would not help
        break;
      }
      if (s.calls >= maxCalls) {
        s.outcome = "max-calls";
        break;
      }
      if (opts.pauseMs) await sleep(opts.pauseMs);
    }
  }
  return summaries;
}

/** Fixed-width table: processed, remaining and rejected per stage. */
export function formatSummary(rows: StageSummary[]): string {
  const head = ["stage", "calls", "processed", "remaining", "rejected", "failed", "result"];
  const body = rows.map((r) => [
    r.stage,
    String(r.calls),
    String(r.processed),
    String(r.remaining),
    String(r.rejected),
    String(r.failed),
    r.error ? `${r.outcome}: ${r.error}` : r.outcome,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 || i === cells.length - 1 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  return [line(head), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(line)].join("\n");
}
