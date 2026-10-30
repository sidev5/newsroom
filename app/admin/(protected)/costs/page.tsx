import { notFound } from "next/navigation";
import { aggregateCosts, totals, type RunRow } from "@/lib/admin/costs";
import { currentAdminEmail } from "@/lib/admin/session";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const DAYS = 30;
const PAGE = 1000;
const MAX_ROWS = 50_000;

function sinceIso(): string {
  return new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();
}

async function loadRuns(since: string): Promise<RunRow[]> {
  const runs: RunRow[] = [];
  // Supabase returns at most 1000 rows per request, so page through.
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await supabaseAdmin()
      .from("agent_runs")
      .select("agent, model, input_tokens, output_tokens, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    runs.push(...(data as RunRow[]));
    if (!data || data.length < PAGE) break;
  }
  return runs;
}

const n = (v: number) => v.toLocaleString("en-US");
const usd = (v: number, lowerBound: boolean) => `${lowerBound ? ">= " : ""}$${v.toFixed(4)}`;

export default async function CostsPage() {
  // Layouts don't protect pages on their own: check again before using the service role.
  if (!(await currentAdminEmail())) notFound();

  const rows = aggregateCosts(await loadRuns(sinceIso()));
  const sum = totals(rows);

  return (
    <main className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">LLM usage, last {DAYS} days (UTC)</h1>
      <p className="text-sm text-zinc-500">
        Cost is a rough estimate from the prices in <code>lib/config.ts</code>. A row marked &quot;&gt;=&quot; includes runs on a
        model with no price set, so its real cost is higher.
      </p>
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b">
            <th className="py-1">Day</th>
            <th>Agent</th>
            <th className="text-right">Runs</th>
            <th className="text-right">Input tokens</th>
            <th className="text-right">Output tokens</th>
            <th className="text-right">Est. cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.day}|${r.agent}`} className="border-b">
              <td className="py-1">{r.day}</td>
              <td>{r.agent}</td>
              <td className="text-right">{n(r.runs)}</td>
              <td className="text-right">{n(r.inputTokens)}</td>
              <td className="text-right">{n(r.outputTokens)}</td>
              <td className="text-right">{usd(r.cost, r.unpriced)}</td>
            </tr>
          ))}
          <tr className="font-semibold">
            <td className="py-1" colSpan={2}>Total</td>
            <td className="text-right">{n(sum.runs)}</td>
            <td className="text-right">{n(sum.inputTokens)}</td>
            <td className="text-right">{n(sum.outputTokens)}</td>
            <td className="text-right">{usd(sum.cost, sum.unpriced)}</td>
          </tr>
        </tbody>
      </table>
      {rows.length === 0 && <p className="text-zinc-500">No LLM runs in this period.</p>}
    </main>
  );
}
