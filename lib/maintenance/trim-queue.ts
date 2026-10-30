// One-off: `npm run stage -- trim-queue --keep 30 [--apply]`. When the write queue (raw items with status 'new-relevant') has grown
// longer than the stage can work through, this keeps the best `keep` items and sets the rest to 'skipped' with the reason
// 'trimmed_backlog'. Nothing is deleted: a skipped item is on the Skipped tab of /admin/review and can be marked relevant again.
// A dry run by default. The rules live here, with the database behind a small interface, so they are tested without one.

export const TRIM_REASON = "trimmed_backlog";
export const DEFAULT_KEEP = 30;
export const MAX_KEEP = 100_000;
const BATCH = 100;

export type QueueRow = { id: string; relevance_score: number | null; fetched_at: string };

export type QueueCounts = { newRelevant: number; skipped: number };

export interface TrimStore {
  /** Every raw item with status 'new-relevant'. */
  queue(): Promise<QueueRow[]>;
  /** How many raw items have status 'new-relevant' and 'skipped' right now. */
  counts(): Promise<QueueCounts>;
  /** Stages that are running at this moment (an unfinished, not stale pipeline_runs row). Empty when it cannot be told. */
  runningStages(): Promise<string[]>;
  /** Sets these items to skipped with the reason, but only those that are still 'new-relevant'. Resolves to how many changed. */
  skip(ids: string[], reason: string): Promise<number>;
}

// ---------------------------------------------------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------------------------------------------------

export type TrimArgs = { ok: true; keep: number; apply: boolean } | { ok: false; error: string };

const USAGE = `Usage: npm run stage -- trim-queue [--keep <number, default ${DEFAULT_KEEP}>] [--apply]   (a dry run unless --apply is given)`;

/** `argv` is process.argv: argv[2] is "trim-queue". Accepts `--keep 30` and `--keep=30`. */
export function parseTrimArgs(argv: string[]): TrimArgs {
  const rest = argv.slice(3);
  let keep = DEFAULT_KEEP;
  let apply = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--apply") apply = true;
    else if (a === "--keep" || a.startsWith("--keep=")) {
      const raw = a === "--keep" ? rest[++i] : a.slice("--keep=".length);
      if (raw === undefined || !/^\d+$/.test(raw)) return { ok: false, error: `--keep needs a whole number, for example --keep 30. ${USAGE}` };
      keep = Number(raw);
    } else return { ok: false, error: `Unknown option: ${a}. ${USAGE}` };
  }
  if (keep < 1 || keep > MAX_KEEP) return { ok: false, error: `--keep must be between 1 and ${MAX_KEEP.toLocaleString("en")} (keeping none would skip the whole queue). ${USAGE}` };
  return { ok: true, keep, apply };
}

// ---------------------------------------------------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Best first: the highest relevance_score, an item with no score last, and among equal scores the newest. The `keep` first are kept.
 * (An id decides a tie of both, so the same queue always gives the same answer.)
 */
export function rankQueue(rows: readonly QueueRow[]): QueueRow[] {
  return [...rows].sort((a, b) => {
    const sa = a.relevance_score ?? Number.NEGATIVE_INFINITY;
    const sb = b.relevance_score ?? Number.NEGATIVE_INFINITY;
    if (sa !== sb) return sb - sa;
    if (a.fetched_at !== b.fetched_at) return a.fetched_at < b.fetched_at ? 1 : -1;
    return a.id < b.id ? -1 : 1;
  });
}

export type TrimPlan = { keep: QueueRow[]; trim: QueueRow[] };

export function planTrim(rows: readonly QueueRow[], keep: number): TrimPlan {
  const ranked = rankQueue(rows);
  return { keep: ranked.slice(0, keep), trim: ranked.slice(keep) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------------------------------------------------

export type TrimResult = {
  apply: boolean;
  keepWanted: number;
  before: QueueCounts;
  /** With a dry run: what the counts would be. With --apply: read from the database afterwards. */
  after: QueueCounts;
  kept: number;
  /** Items chosen for trimming. */
  planned: number;
  /** Items actually changed (with --apply); items that left the queue meanwhile are not counted. */
  trimmed: number;
  keptScores: { highest: number | null; lowest: number | null; unscored: number };
  trimmedScores: { highest: number | null; lowest: number | null; unscored: number };
};

const scores = (rows: readonly QueueRow[]) => {
  const s = rows.map((r) => r.relevance_score).filter((v): v is number => v !== null);
  return { highest: s.length ? Math.max(...s) : null, lowest: s.length ? Math.min(...s) : null, unscored: rows.length - s.length };
};

export class TrimRefused extends Error {}

export async function runTrimQueue(store: TrimStore, options: { keep: number; apply: boolean }): Promise<TrimResult> {
  const before = await store.counts();
  const plan = planTrim(await store.queue(), options.keep);

  if (options.apply && plan.trim.length > 0) {
    // An item that is being written right now must not be pulled away from the stage.
    const running = await store.runningStages();
    if (running.includes("write") || running.includes("classify")) {
      throw new TrimRefused(`The ${running.filter((s) => s === "write" || s === "classify").join(" and ")} stage is running right now. Wait until it has finished, then run this again.`);
    }
  }

  let trimmed = 0;
  if (options.apply) {
    const ids = plan.trim.map((r) => r.id);
    for (let i = 0; i < ids.length; i += BATCH) trimmed += await store.skip(ids.slice(i, i + BATCH), TRIM_REASON);
  }

  const after = options.apply
    ? await store.counts()
    : { newRelevant: before.newRelevant - plan.trim.length, skipped: before.skipped + plan.trim.length };

  return {
    apply: options.apply,
    keepWanted: options.keep,
    before,
    after,
    kept: plan.keep.length,
    planned: plan.trim.length,
    trimmed,
    keptScores: scores(plan.keep),
    trimmedScores: scores(plan.trim),
  };
}

const range = (s: TrimResult["keptScores"]) => (s.highest === null ? "no scores" : s.highest === s.lowest ? `score ${s.highest}` : `scores ${s.highest} down to ${s.lowest}`) + (s.unscored ? `, ${s.unscored} without a score` : "");

export function formatTrim(r: TrimResult): string {
  const pad = (n: number) => String(n).padStart(6);
  const lines = [
    r.apply ? "APPLIED: items were changed." : "DRY RUN: nothing was changed. Add --apply to do it.",
    "",
    `Before:  'new-relevant' ${pad(r.before.newRelevant)}   'skipped' ${pad(r.before.skipped)}`,
    `Keep the best ${r.keepWanted} (highest relevance_score first, then newest): keeping ${r.kept} (${range(r.keptScores)}).`,
    r.planned === 0
      ? "Nothing to trim: the queue is not longer than that."
      : `${r.apply ? "Trimmed" : "Would trim"} ${r.apply ? r.trimmed : r.planned} to 'skipped' with classify_reason '${TRIM_REASON}' (${range(r.trimmedScores)}).` +
        (r.apply && r.trimmed !== r.planned ? ` ${r.planned - r.trimmed} of the ${r.planned} chosen had already left the queue.` : ""),
    `After${r.apply ? ": " : " (would be):"} 'new-relevant' ${pad(r.after.newRelevant)}   'skipped' ${pad(r.after.skipped)}`,
  ];
  if (r.planned > 0) lines.push("", "Nothing is deleted. Skipped items are on the Skipped tab of /admin/review, where \"Mark relevant\" puts one back in the queue.");
  return lines.join("\n");
}
