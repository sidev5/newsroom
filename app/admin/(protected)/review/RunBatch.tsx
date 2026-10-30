"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LOGIN_EXPIRED_PATH } from "@/lib/admin/messages";
import { STAGE_ORDER } from "@/lib/pipeline/stage-names";
import { runStageAction, type StageStep, type StageStopped } from "../actions";

/** What to add to a stage's line when it stopped for a reason that is not an error. Rate limits have their own text. */
function stopNote(stopped: StageStopped): string {
  if (stopped === "budget_exceeded") return " · daily spend limit reached, items left queued";
  if (stopped === "time_budget") return " · time limit reached, the rest stays queued";
  if (stopped === "provider_error") return " · provider problem, items left queued";
  return "";
}

type Row = { state: "waiting" | "running" | "done" | "error"; step?: StageStep };

const initial = () => Object.fromEntries(STAGE_ORDER.map((s) => [s, { state: "waiting" } as Row]));

/** Runs one chunk of each stage in order, one server call per stage, and shows each as it finishes. */
export function RunBatch({ chunkSize }: { chunkSize: number }) {
  const router = useRouter();
  const [rows, setRows] = useState<Record<string, Row>>(initial);
  const [running, setRunning] = useState(false);
  const [started, setStarted] = useState(false);

  async function run() {
    setRunning(true);
    setStarted(true);
    setRows(initial());
    for (const stage of STAGE_ORDER) {
      setRows((r) => ({ ...r, [stage]: { state: "running" } }));
      let step: StageStep;
      try {
        step = await runStageAction(stage);
      } catch (err) {
        step = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      // An expired session ends the run and goes to the login page, like every other admin action.
      if (!step.ok && step.error === "Not authorised.") {
        window.location.assign(LOGIN_EXPIRED_PATH);
        return;
      }
      // A failing stage does not stop the later ones: they work on rows that already exist.
      setRows((r) => ({ ...r, [stage]: { state: step.ok ? "done" : "error", step } }));
    }
    setRunning(false);
    router.refresh(); // update the funnel and last-run table
  }

  return (
    <div className="flex flex-col gap-3">
      <button type="button" onClick={run} disabled={running} className="w-fit rounded bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50">
        {running ? "Running…" : "Run next batch"}
      </button>
      <p className="text-xs text-zinc-500">One chunk of up to {chunkSize} items per stage. Run it again to continue.</p>
      {started && (
        <ol className="flex flex-col gap-1 text-sm" aria-live="polite">
          {STAGE_ORDER.map((stage) => {
            const row = rows[stage];
            const step = row.step;
            return (
              <li key={stage} className="grid grid-cols-[6rem_1fr] gap-2">
                <span className="font-medium">{stage}</span>
                <span className={row.state === "error" ? "text-red-700" : ""}>
                  {row.state === "waiting" && "waiting"}
                  {row.state === "running" && "running…"}
                  {step?.ok &&
                    `processed ${step.processed} · remaining ${step.remaining}${step.rejected ? ` · rejected ${step.rejected}` : ""}${step.failed ? ` · failed ${step.failed}` : ""}${step.rateLimited ? " · rate limited, left queued" : ""}${stopNote(step.stopped)}${step.stoppedError ? ` (${step.stoppedError})` : ""}`}
                  {step && !step.ok && step.error}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
