import { addComment } from "@/lib/reader/engagement";
import { json, readJson, refuseUnlessSameSiteJson, SLUG, STATUS } from "@/lib/reader/http";
import { engagementDeps, sessionOf } from "@/lib/reader/runtime";

export const dynamic = "force-dynamic";

/** POST /api/story/<slug>/comments {body}: adds a comment. Needs a signed-in reader; limited per hour and per day; no repeats. */
export async function POST(request: Request, ctx: RouteContext<"/api/story/[slug]/comments">) {
  const refused = refuseUnlessSameSiteJson(request);
  if (refused) return refused;
  const { slug } = await ctx.params;
  if (!SLUG.test(slug)) return json({ ok: false, error: "Not found." }, 404);
  const body = await readJson(request);
  if (typeof body?.body !== "string") return json({ ok: false, error: "Write a comment first." }, 422);
  try {
    const result = await addComment(engagementDeps(), { slug, session: sessionOf(request.headers), body: body.body });
    return result.ok ? json(result, 201) : json(result, STATUS[result.kind]);
  } catch (err) {
    console.error(`reader: comment failed: ${err instanceof Error ? err.message : "unknown"}`);
    return json({ ok: false, error: "Your comment could not be saved. Please try again." }, 500);
  }
}