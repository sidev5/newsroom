import { toggleLike } from "@/lib/reader/engagement";
import { json, refuseUnlessSameSiteJson, SLUG, STATUS } from "@/lib/reader/http";
import { engagementDeps, sessionOf } from "@/lib/reader/runtime";

export const dynamic = "force-dynamic";

/** POST /api/story/<slug>/like: likes the story, or takes the like back. Needs a signed-in reader. */
export async function POST(request: Request, ctx: RouteContext<"/api/story/[slug]/like">) {
  const refused = refuseUnlessSameSiteJson(request);
  if (refused) return refused;
  const { slug } = await ctx.params;
  if (!SLUG.test(slug)) return json({ ok: false, error: "Not found." }, 404);
  try {
    const result = await toggleLike(engagementDeps(), { slug, session: sessionOf(request.headers) });
    return result.ok ? json(result) : json(result, STATUS[result.kind]);
  } catch (err) {
    console.error(`reader: like failed: ${err instanceof Error ? err.message : "unknown"}`);
    return json({ ok: false, error: "Your like could not be saved. Please try again." }, 500);
  }
}