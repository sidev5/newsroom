import { rejectUnlessCron } from "@/lib/cron-auth";
import { reminderDeps } from "@/lib/digest/runtime";
import { runScheduledSend } from "@/lib/digest/service";
import { DigestSchemaError } from "@/lib/digest/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Weekly: sends this week's digest only if an admin approved it. A digest that is still a draft is NOT
 * sent; the admins get a reminder instead.
 */
export async function GET(request: Request) {
  const denied = rejectUnlessCron(request);
  if (denied) return denied;

  try {
    return Response.json(await runScheduledSend(reminderDeps()));
  } catch (err) {
    if (err instanceof DigestSchemaError) return Response.json({ error: err.message }, { status: 503 });
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
