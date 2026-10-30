import { MODEL_PRICES_USD_PER_MTOK } from "@/lib/config";

export type RunRow = { agent: string; model: string; input_tokens: number; output_tokens: number; created_at: string };

export type Prices = Record<string, { input: number; output: number }>;

export type CostRow = {
  day: string; // YYYY-MM-DD, UTC
  agent: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  /** USD, counting only runs whose model has a price. */
  cost: number;
  /** True when some runs were on a model with no price, so `cost` is a lower bound. */
  unpriced: boolean;
};

/** Longest configured model name that prefixes the recorded one (API names can carry a version suffix). */
export function priceFor(model: string, prices: Prices = MODEL_PRICES_USD_PER_MTOK) {
  const key = Object.keys(prices)
    .filter((k) => model === k || model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return key ? prices[key] : undefined;
}

export function runCost(run: Pick<RunRow, "model" | "input_tokens" | "output_tokens">, prices?: Prices): number | null {
  const p = priceFor(run.model, prices);
  return p ? (run.input_tokens * p.input + run.output_tokens * p.output) / 1_000_000 : null;
}

/** One row per day and agent, newest day first. */
export function aggregateCosts(runs: RunRow[], prices: Prices = MODEL_PRICES_USD_PER_MTOK): CostRow[] {
  const rows = new Map<string, CostRow>();
  for (const run of runs) {
    const day = new Date(run.created_at).toISOString().slice(0, 10);
    const key = `${day}|${run.agent}`;
    const row = rows.get(key) ?? { day, agent: run.agent, runs: 0, inputTokens: 0, outputTokens: 0, cost: 0, unpriced: false };
    row.runs++;
    row.inputTokens += run.input_tokens;
    row.outputTokens += run.output_tokens;
    const cost = runCost(run, prices);
    if (cost === null) row.unpriced = true;
    else row.cost += cost;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.day.localeCompare(a.day) || a.agent.localeCompare(b.agent));
}

export function totals(rows: CostRow[]) {
  return rows.reduce(
    (t, r) => ({
      runs: t.runs + r.runs,
      inputTokens: t.inputTokens + r.inputTokens,
      outputTokens: t.outputTokens + r.outputTokens,
      cost: t.cost + r.cost,
      unpriced: t.unpriced || r.unpriced,
    }),
    { runs: 0, inputTokens: 0, outputTokens: 0, cost: 0, unpriced: false },
  );
}
