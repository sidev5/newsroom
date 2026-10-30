import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { budgetCostOf, type BudgetOverride, type BudgetStore } from "./budget";

const PAGE = 1000;

/** The service-role implementation: agent_runs for the spend, budget_overrides for the admin's raised limit. */
export function supabaseBudgetStore(): BudgetStore {
  return {
    async spentSince(startIso) {
      const db = supabaseAdmin();
      let total = 0;
      // PostgREST returns at most 1000 rows per request; a busy day can have more calls than that.
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await db
          .from("agent_runs")
          .select("model, input_tokens, output_tokens")
          .gte("created_at", startIso)
          .order("created_at", { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) throw new Error(`Reading today's spend failed: ${error.message}`);
        const rows = (data ?? []) as { model: string; input_tokens: number; output_tokens: number }[];
        total += budgetCostOf(rows);
        if (rows.length < PAGE) return total;
      }
    },

    async override(day) {
      const { data, error } = await supabaseAdmin()
        .from("budget_overrides")
        .select("limit_usd, raised_by, created_at")
        .eq("day", day)
        .order("limit_usd", { ascending: false })
        .limit(1);
      if (error) {
        // The table does not exist until supabase/migrations/2026-10-19_reliability.sql has been run: no override then.
        if (/budget_overrides|relation|schema cache/i.test(error.message)) return null;
        throw new Error(`Reading the budget override failed: ${error.message}`);
      }
      const row = (data ?? [])[0] as { limit_usd: number | string; raised_by: string; created_at: string } | undefined;
      return row ? ({ limit_usd: Number(row.limit_usd), raised_by: row.raised_by, created_at: row.created_at } satisfies BudgetOverride) : null;
    },
  };
}

/** Records an admin raising today's limit. The table is the audit trail: one row per raise, never updated. */
export async function insertBudgetOverride(day: string, limitUsd: number, raisedBy: string, previousLimitUsd: number): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("budget_overrides")
    .insert({ day, limit_usd: limitUsd, previous_limit_usd: previousLimitUsd, raised_by: raisedBy });
  if (error) throw new Error(error.message);
}
