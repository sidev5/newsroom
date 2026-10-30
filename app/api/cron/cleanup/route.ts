import { rejectUnlessCron } from "@/lib/cron-auth";
import { env } from "@/lib/env";
import { runCleanup } from "@/lib/maintenance/cleanup";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Retention (DB-03, and SEC-13 for the submitters' personal data). GET /api/cron/cleanup is a dry run: it counts what would be touched and changes nothing.
 * GET /api/cron/cleanup?apply=true does it. The weekly run in .github/workflows/pipeline.yml uses apply=true.
 */
export async function GET(request: Request) {
  const denied = rejectUnlessCron(request);
  if (denied) return denied;

  const flag = new URL(request.url).searchParams.get("apply");
  const apply = flag === "true" || flag === "1";
  try {
    // SUBMITTER_IP_RETENTION_DAYS and SUBMITTER_EMAIL_RETENTION_DAYS; an invalid environment falls back to the defaults.
    let days: { ipHashDays?: number; emailDays?: number } = {};
    try {
      const e = env();
      days = { ipHashDays: e.SUBMITTER_IP_RETENTION_DAYS, emailDays: e.SUBMITTER_EMAIL_RETENTION_DAYS };
    } catch {
      // the defaults apply
    }
    return Response.json(await runCleanup({ apply, ...days }));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
