// npm run stage -- trim-queue [--keep 30] [--apply]
// One-off: keeps the best N raw items waiting to be written ('new-relevant') and sets the rest to 'skipped' (classify_reason
// 'trimmed_backlog'). A dry run unless --apply is given. It talks to the database named in .env.local with the service role,
// so it prints which one before it does anything. The rules are in lib/maintenance/trim-queue.ts.
import { createClient } from "@supabase/supabase-js";
import { loadEnvConfig } from "@next/env";
import { STAGE_LOCK_STALE_MS } from "../lib/config";
import { formatTrim, parseTrimArgs, runTrimQueue, TrimRefused, type QueueRow, type TrimStore } from "../lib/maintenance/trim-queue";

const PAGE = 1000;

export async function trimQueueMain(argv: string[]): Promise<void> {
  const args = parseTrimArgs(argv);
  if (!args.ok) {
    console.error(args.error);
    process.exit(1);
  }

  loadEnvConfig(process.cwd(), true);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (.env.local).");
    process.exit(1);
  }
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const store: TrimStore = {
    async queue() {
      const rows: QueueRow[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await db
          .from("raw_items")
          .select("id, relevance_score, fetched_at")
          .eq("status", "new-relevant")
          .order("fetched_at", { ascending: false })
          .order("id")
          .range(from, from + PAGE - 1);
        if (error) throw new Error(`Loading the queue failed: ${error.message}`);
        rows.push(...((data ?? []) as QueueRow[]));
        if (!data || data.length < PAGE) return rows;
      }
    },
    async counts() {
      const count = async (status: string) => {
        const { count: n, error } = await db.from("raw_items").select("id", { count: "exact", head: true }).eq("status", status);
        if (error) throw new Error(`Counting '${status}' failed: ${error.message}`);
        return n ?? 0;
      };
      const [newRelevant, skipped] = await Promise.all([count("new-relevant"), count("skipped")]);
      return { newRelevant, skipped };
    },
    async runningStages() {
      // pipeline_runs exists after 2026-10-19_reliability.sql; if it cannot be read, nothing is known to be running.
      const since = new Date(Date.now() - STAGE_LOCK_STALE_MS).toISOString();
      const { data, error } = await db.from("pipeline_runs").select("stage").is("finished_at", null).gte("started_at", since);
      return error ? [] : ((data ?? []) as { stage: string }[]).map((r) => r.stage);
    },
    async skip(ids, reason) {
      // Only items that are still waiting: one that was written or changed in the meantime is left alone.
      const { data, error } = await db.from("raw_items").update({ status: "skipped", classify_reason: reason }).in("id", ids).eq("status", "new-relevant").select("id");
      if (error) throw new Error(`Updating items failed: ${error.message}`);
      return data?.length ?? 0;
    },
  };

  console.log(`Database: ${new URL(url).host}`);
  console.log(`Mode:     ${args.apply ? "APPLY (items will be changed)" : "dry run"}\n`);
  try {
    console.log(formatTrim(await runTrimQueue(store, { keep: args.keep, apply: args.apply })));
  } catch (err) {
    console.error(err instanceof TrimRefused ? err.message : err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// Run directly (`tsx scripts/trim-queue.ts ...`); `npm run stage -- trim-queue` calls trimQueueMain itself.
if (process.argv[1] && /trim-queue\.(ts|js)$/.test(process.argv[1].replace(/\\/g, "/"))) {
  void trimQueueMain(["node", "trim-queue", "trim-queue", ...process.argv.slice(2)]);
}
