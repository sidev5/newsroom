// Dev-only: trigger a cron stage against the local dev server.
// Usage: npm run stage -- <ingest|classify|write|image|factcheck|health>   one call to one stage
//        npm run stage -- all                                              the whole pipeline, to completion
//        npm run stage -- cleanup [--apply]                                retention: a dry run (counts only), or with --apply for real
//        npm run stage -- purge-sample [--apply]                           list the test articles, submissions and placeholder sources, or delete them
//        npm run stage -- trim-queue [--keep 30] [--apply]                 one-off: keep the best 30 items waiting to be written, skip the rest (dry run unless --apply)
import { config } from "dotenv";
import { formatPurge, type PurgeResult } from "../lib/maintenance/purge-sample";
import { cronUrl, parseStageArgs } from "../lib/maintenance/stage-args";
import { formatSummary, runAll, type StageCall } from "../lib/pipeline/run-all";
import { STAGE_ORDER } from "../lib/pipeline/stage-names";

config({ path: ".env.local" });

const STAGES = ["health", "cleanup", "purge-sample", "trim-queue", ...STAGE_ORDER];

async function main() {
  // trim-queue talks to the database directly (no dev server, no cron route), so it is handled before anything else.
  if (process.argv[2] === "trim-queue") {
    const { trimQueueMain } = await import("./trim-queue");
    return trimQueueMain(process.argv);
  }
  const args = parseStageArgs(process.argv, STAGES);
  if (!args.ok) {
    console.error(args.error);
    process.exit(1);
  }
  const { stage, apply } = args;

  const base = process.env.APP_URL ?? "http://localhost:3000";
  const host = new URL(base).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    console.error(`Refusing to run against ${base}: this script is for local dev only.`);
    process.exit(1);
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("CRON_SECRET is not set in .env.local");
    process.exit(1);
  }

  // `cleanup` is a dry run (it only counts) unless --apply is given.
  const call = (name: string) => fetch(cronUrl(base, name, apply), { headers: { Authorization: `Bearer ${secret}` } });
  if (stage === "all") {
    const callStage = async (name: string): Promise<StageCall> => {
      try {
        const res = await call(name);
        const text = await res.text();
        let body: StageCall["body"] = null;
        try {
          body = JSON.parse(text);
        } catch {
          // not JSON: reported below
        }
        if (!res.ok) return { ok: false, body: null, error: `${res.status} ${(body as { error?: string } | null)?.error ?? text.slice(0, 120)}` };
        return { ok: true, body };
      } catch (err) {
        return { ok: false, body: null, error: err instanceof Error ? err.message : String(err) };
      }
    };

    const pauseMs = Number(process.env.STAGE_DELAY_MS ?? 1500);
    const rows = await runAll((s) => callStage(s), {
      pauseMs: Number.isFinite(pauseMs) ? pauseMs : 1500,
      onCall: (s, c) => {
        const b = c.body;
        console.log(c.ok ? `${s}: processed ${b?.processed ?? 0}, remaining ${b?.remaining ?? 0}${b?.rateLimited ? " (rate limited)" : ""}` : `${s}: ${c.error}`);
        if (c.ok && b?.stoppedError) console.error(`  stopped (${b.stopped ?? "?"}): ${b.stoppedError}`);
      },
    });
    console.log(`\n${formatSummary(rows)}`);
    if (rows.some((r) => r.outcome === "error")) process.exit(1);
    return;
  }

  const res = await call(stage);
  const text = await res.text();
  console.log(`${res.status} ${res.statusText}`);
  // purge-sample answers with data that is easier to read as a summary than as JSON.
  if (stage === "purge-sample" && res.ok) {
    try {
      console.log(formatPurge(JSON.parse(text) as PurgeResult));
      return;
    } catch {
      // not the expected shape: print it as it is below
    }
  }
  try {
    const body = JSON.parse(text) as { stopped?: string | null; stoppedError?: string | null };
    console.log(JSON.stringify(body, null, 2));
    // The provider's own words (HTTP status and message), on a line of their own so they are not lost in the JSON.
    if (body.stoppedError) console.error(`\n${stage} stopped (${body.stopped ?? "?"}): ${body.stoppedError}`);
  } catch {
    console.log(text);
  }
  if (!res.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
