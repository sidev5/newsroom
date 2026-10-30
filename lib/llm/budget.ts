import { MODEL_PRICES_USD_PER_MTOK } from "@/lib/config";
import { priceFor, type Prices } from "@/lib/admin/costs";

// BE-04: a daily spend cap. The spend of "today" is what agent_runs already records (tokens per call) priced with
// MODEL_PRICES_USD_PER_MTOK. A day is a calendar day in Asia/Kolkata (UTC+5:30, no daylight saving), like the digest week.

const IST_OFFSET_MS = 5.5 * 3_600_000;

/** "2026-10-16": the Asia/Kolkata calendar day of `now`. */
export function budgetDay(now: Date): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The instant (UTC) at which that Asia/Kolkata day began. */
export function budgetDayStart(day: string): Date {
  return new Date(Date.parse(`${day}T00:00:00Z`) - IST_OFFSET_MS);
}

/**
 * A model with no entry in the price table (gemini-3.6-flash today) is counted at the highest known price instead of
 * as free: a cap that ignored the model doing most of the work would never trigger. Prices are rough on purpose.
 */
export function fallbackPrice(prices: Prices = MODEL_PRICES_USD_PER_MTOK): { input: number; output: number } {
  const all = Object.values(prices);
  return { input: Math.max(...all.map((p) => p.input)), output: Math.max(...all.map((p) => p.output)) };
}

export type PricedRun = { model: string; input_tokens: number; output_tokens: number };

/** USD for one recorded call. */
export function budgetCost(run: PricedRun, prices: Prices = MODEL_PRICES_USD_PER_MTOK): number {
  const p = priceFor(run.model, prices) ?? fallbackPrice(prices);
  return (run.input_tokens * p.input + run.output_tokens * p.output) / 1_000_000;
}

export function budgetCostOf(runs: PricedRun[], prices: Prices = MODEL_PRICES_USD_PER_MTOK): number {
  return runs.reduce((sum, r) => sum + budgetCost(r, prices), 0);
}

export type BudgetOverride = { limit_usd: number; raised_by: string; created_at: string };

export interface BudgetStore {
  /** USD spent by agent_runs created at or after `startIso`. */
  spentSince(startIso: string): Promise<number>;
  /** The highest limit an admin set for this day, or null. */
  override(day: string): Promise<BudgetOverride | null>;
}

export type BudgetState = {
  day: string;
  spentUsd: number;
  /** The limit in force today: DAILY_BUDGET_USD, or the admin's override when that is higher. */
  limitUsd: number;
  baseLimitUsd: number;
  raisedBy: string | null;
  exceeded: boolean;
};

export async function loadBudgetState(store: BudgetStore, now: Date, baseLimitUsd: number): Promise<BudgetState> {
  const day = budgetDay(now);
  const [spentUsd, override] = await Promise.all([store.spentSince(budgetDayStart(day).toISOString()), store.override(day)]);
  const raised = override && override.limit_usd > baseLimitUsd ? override : null;
  const limitUsd = raised ? raised.limit_usd : baseLimitUsd;
  return { day, spentUsd, limitUsd, baseLimitUsd, raisedBy: raised?.raised_by ?? null, exceeded: spentUsd >= limitUsd };
}

export type BudgetCheck = { allowed: true } | { allowed: false; state: BudgetState };

export type BudgetGuard = {
  check(): Promise<BudgetCheck>;
  /** Adds a finished call to the running total, so the cap holds between reloads. */
  record(run: PricedRun): void;
};

/**
 * Checks the cap before every LLM call. The total is read from the database, kept for `ttlMs`, and grown by each
 * call this process makes, so a stage does not query agent_runs once per item. Two processes at once can overshoot by
 * what they spend during one ttl. If the total cannot be read the call is allowed (and the problem logged once): the
 * cap is a safety net, not a reason to stop the newsroom when a query fails.
 */
export function createBudgetGuard(args: {
  store: BudgetStore;
  baseLimitUsd: () => number;
  now?: () => Date;
  ttlMs?: number;
  log?: (message: string) => void;
}): BudgetGuard {
  const now = args.now ?? (() => new Date());
  const ttlMs = args.ttlMs ?? 15_000;
  const log = args.log ?? console.error;
  let state: BudgetState | null = null;
  let loadedAt = 0;
  let warned = false;

  return {
    async check() {
      try {
        const t = now();
        if (!state || t.getTime() - loadedAt > ttlMs || state.day !== budgetDay(t)) {
          state = await loadBudgetState(args.store, t, args.baseLimitUsd());
          loadedAt = t.getTime();
        }
        return state.exceeded ? { allowed: false, state } : { allowed: true };
      } catch (err) {
        if (!warned) {
          warned = true;
          log(`daily budget check failed, allowing the call: ${err instanceof Error ? err.message : String(err)}`);
        }
        return { allowed: true };
      }
    },
    record(run) {
      if (!state) return;
      state.spentUsd += budgetCost(run);
      state.exceeded = state.spentUsd >= state.limitUsd;
    },
  };
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** The sentence stages and banners use. */
export function budgetMessage(s: BudgetState): string {
  return `Daily AI spend limit reached: ${formatUsd(s.spentUsd)} of ${formatUsd(s.limitUsd)} today (${s.day}, Asia/Kolkata). Stages are paused and their items stay queued; the count restarts at midnight IST.`;
}
