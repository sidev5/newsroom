import { rejectUnlessCron } from "@/lib/cron-auth";
import { runPurgeSample } from "@/lib/maintenance/purge-sample";
import { supabasePurgeStore } from "@/lib/maintenance/purge-store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Sample data before the pilot. GET /api/cron/purge-sample LISTS what is test content and deletes nothing.
 * GET /api/cron/purge-sample?apply=true deletes it. Not scheduled anywhere (vercel.json, .github/workflows): it is run by hand, with `npm run stage -- purge-sample [--apply]`.
 */
export async function GET(request: Request) {
  const denied = rejectUnlessCron(request);
  if (denied) return denied;

  const flag = new URL(request.url).searchParams.get("apply");
  const apply = flag === "true" || flag === "1";
  try {
    const result = await runPurgeSample({ apply }, supabasePurgeStore());
    console.log(`purge-sample (${apply ? "applied" : "dry run"}): ${result.articles.length} articles, ${result.raw_items} raw items, ${result.sources.length} sources`);
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}