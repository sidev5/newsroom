import Link from "next/link";
import { loadAdminAlerts } from "@/lib/admin/alerts";
import { budgetMessage } from "@/lib/llm/budget";
import { raiseBudgetAction } from "./actions";

const box = "mb-6 rounded border p-3 text-sm";

/**
 * Banners at the top of every admin page (so also on the Pipeline tab):
 * - the daily AI spend limit is reached: stages are paused, with the form to raise today's limit (BE-04);
 * - a stage has failed twice or more in a row (BE-06). When email is configured the admins also got one email.
 */
export async function AlertBanners() {
  const { budget, failing } = await loadAdminAlerts();
  if (!budget && failing.length === 0) return null;

  return (
    <div>
      {budget && (
        <section role="alert" aria-label="Daily AI spend limit" className={`${box} border-red-300 bg-red-50 text-red-900`}>
          <p className="font-medium">{budgetMessage(budget)}</p>
          {budget.raisedBy && <p className="mt-1">The limit was already raised once today (by {budget.raisedBy}).</p>}
          <form className="mt-3 flex flex-wrap items-end gap-2">
            <input type="hidden" name="tab" value="pipeline" />
            <label className="flex flex-col gap-1 text-xs">
              New limit for today, in USD
              <input
                name="limit"
                type="number"
                inputMode="decimal"
                step="0.5"
                min={budget.limitUsd + 0.5}
                defaultValue={Math.floor(budget.limitUsd) + 2}
                required
                className="w-32 rounded border bg-white p-2 text-sm"
              />
            </label>
            <button formAction={raiseBudgetAction} className="rounded border border-red-700 bg-red-700 px-3 py-2 text-sm text-white">
              Raise today&apos;s limit
            </button>
            <span className="text-xs">The change is logged with your email. It holds until midnight IST.</span>
          </form>
        </section>
      )}

      {failing.map((f) => (
        <p key={f.stage} role="alert" className={`${box} border-red-300 bg-red-50 text-red-900`}>
          The <strong>{f.stage}</strong> stage has failed {f.count} times in a row. Last error: {(f.lastError ?? "unknown").slice(0, 200)}{" "}
          <Link href="/admin/review?tab=pipeline" className="font-medium underline">
            Open the Pipeline tab
          </Link>
          .{f.alerted ? " The admins were sent an alert email." : ""}
        </p>
      ))}
    </div>
  );
}
