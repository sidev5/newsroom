import { rejectUnlessCron } from "@/lib/cron-auth";
import { digestDeps } from "@/lib/digest/runtime";
import { createDraft } from "@/lib/digest/service";
import { DigestSchemaError } from "@/lib/digest/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Weekly: builds this week's digest draft. It never sends anything. */
export async function GET(request: Request) {
  const denied = rejectUnlessCron(request);
  if (denied) return denied;

  try {
    const result = await createDraft(digestDeps(), "cron");
    return Response.json({
      result: result.kind,
      id: result.digest.id,
      week_start: result.digest.week_start,
      status: result.digest.status,
      stories: result.digest.article_ids.length,
      ...(result.kind === "skipped" ? { message: result.reason } : {}),
    });
  } catch (err) {
    if (err instanceof DigestSchemaError) return Response.json({ error: err.message }, { status: 503 });
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
