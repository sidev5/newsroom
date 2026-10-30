import "server-only";
import { type BudgetState } from "@/lib/llm/budget";
import { failureStreak, isRepeatedFailure, type FailureStreak, type RunStore } from "@/lib/pipeline/run-log";
import { supabaseRunStore } from "@/lib/pipeline/run-store";
import { STAGE_ORDER } from "@/lib/pipeline/stage-names";
import { getBudgetStatus } from "./budget-admin";

/** What the banner at the top of every admin page reports. */
export type AdminAlerts = {
  /** Set only when today's spend has reached the limit. */
  budget: BudgetState | null;
  /** Stages that have failed twice or more in a row. */
  failing: FailureStreak[];
};

/** Stages whose latest runs show a streak of failures. A stage that cannot be read is left out, not reported. */
export async function failingStages(store: Pick<RunStore, "recent">): Promise<FailureStreak[]> {
  const streaks = await Promise.all(
    STAGE_ORDER.map(async (stage) => {
      try {
        return failureStreak(stage, await store.recent(stage, 20));
      } catch {
        return null;
      }
    }),
  );
  return streaks.filter((s): s is FailureStreak => s !== null && isRepeatedFailure(s));
}

/** For the admin layout. Never throws: an alert that cannot be computed must not take the admin pages down. */
export async function loadAdminAlerts(): Promise<AdminAlerts> {
  const [status, failing] = await Promise.all([getBudgetStatus(), failingStages(supabaseRunStore()).catch(() => [] as FailureStreak[])]);
  return { budget: status?.exceeded ? status : null, failing };
}
