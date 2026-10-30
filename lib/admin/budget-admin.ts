import "server-only";
import { env } from "@/lib/env";
import { loadBudgetState, formatUsd, type BudgetState, type BudgetStore } from "@/lib/llm/budget";
import { insertBudgetOverride, supabaseBudgetStore } from "@/lib/llm/budget-store";
import { resetBudgetGuard } from "@/lib/llm";
import { NOT_AUTHORISED } from "./messages";
import { currentAdminEmail } from "./session";

// BE-04, the admin's side: today's spend against the limit, and "Raise today's limit".

/** The highest limit an admin can set for a day, so a typo (5000 for 5) cannot remove the cap. */
export const MAX_LIMIT_USD = 1000;

export type RaiseResult = { ok: true; limit: number; previous: number } | { ok: false; error: string };

export type RaiseDeps = {
  adminEmail: () => Promise<string | null>;
  /** Today's spend and limit. */
  state: () => Promise<BudgetState>;
  /** Stores the raise: the table is the audit trail. */
  insert: (day: string, limitUsd: number, raisedBy: string, previousLimitUsd: number) => Promise<void>;
  /** Called after a successful raise (drops the process's cached total). */
  after?: () => void;
  log?: (line: string) => void;
};

/** "5", "5.5", "$5" or " 7.25 " as dollars rounded to cents; null when it is not a positive amount. */
export function parseDollars(input: unknown): number | null {
  const text = typeof input === "number" ? String(input) : typeof input === "string" ? input.trim().replace(/^\$/, "").replace(/,/g, "") : "";
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/**
 * Raises today's limit. Admin only (checked first); the new limit must be higher than the one in force and at most
 * MAX_LIMIT_USD; it holds until midnight IST. Each raise is stored with who did it and what it replaced, and logged.
 */
export async function raiseTodaysLimit(input: unknown, deps: RaiseDeps = defaultDeps()): Promise<RaiseResult> {
  const admin = await deps.adminEmail();
  if (!admin) return { ok: false, error: NOT_AUTHORISED };

  const limit = parseDollars(input);
  if (limit === null) return { ok: false, error: "Enter an amount in dollars, for example 5." };
  if (limit > MAX_LIMIT_USD) return { ok: false, error: `That is more than the highest limit that can be set (${formatUsd(MAX_LIMIT_USD)}).` };

  const state = await deps.state();
  if (limit <= state.limitUsd) return { ok: false, error: `The new limit must be higher than today's limit (${formatUsd(state.limitUsd)}).` };

  await deps.insert(state.day, limit, admin, state.limitUsd);
  (deps.log ?? console.log)(`budget: ${admin} raised the limit for ${state.day} from ${formatUsd(state.limitUsd)} to ${formatUsd(limit)} (spent so far ${formatUsd(state.spentUsd)})`);
  deps.after?.();
  return { ok: true, limit, previous: state.limitUsd };
}

function defaultDeps(): RaiseDeps {
  return { adminEmail: currentAdminEmail, state: getBudgetState, insert: insertBudgetOverride, after: resetBudgetGuard };
}

/** Today's budget state from the database. Throws if it cannot be read. */
export function getBudgetState(store: BudgetStore = supabaseBudgetStore(), now: Date = new Date()): Promise<BudgetState> {
  return loadBudgetState(store, now, env().DAILY_BUDGET_USD);
}

/** For display: the state, or null when it cannot be read (the page then simply shows no budget line). */
export async function getBudgetStatus(): Promise<BudgetState | null> {
  try {
    return await getBudgetState();
  } catch (err) {
    console.error(`reading the daily budget failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
