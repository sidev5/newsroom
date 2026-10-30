import "server-only";
import { rejectUnlessCron } from "@/lib/cron-auth";
import { StageBusyError } from "./run-log";
import { runStage, type StageName } from "./stages";

/**
 * The body of every /api/cron/<stage> route: bearer check, run the stage, answer with its summary.
 * A stage that is already running (cron overlapping the admin button, or a slow earlier run) answers 409 and does nothing.
 */
export async function handleStageRequest(stage: StageName, request: Request): Promise<Response> {
  const denied = rejectUnlessCron(request);
  if (denied) return denied;

  try {
    return Response.json(await runStage(stage, "cron"));
  } catch (err) {
    if (err instanceof StageBusyError) return Response.json({ error: err.message, busy: true }, { status: 409 });
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
