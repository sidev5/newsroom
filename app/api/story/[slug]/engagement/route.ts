import { getEngagement } from "@/lib/reader/engagement";
import { json, SLUG, STATUS } from "@/lib/reader/http";
import { engagementDeps, readerSignInAvailable, sessionOf } from "@/lib/reader/runtime";

export const dynamic = "force-dynamic";

/**
 * GET /api/story/<slug>/engagement: the likes and comments of a published Write story, and whether the signed-in reader has liked
 * it. `signIn` says whether readers can sign in at all (it needs mail and a company domain list). Never cached.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/story/[slug]/engagement">) {
  const { slug } = await ctx.params;
  if (!SLUG.test(slug)) return json({ ok: false, error: "Not found." }, 404);
  const session = sessionOf(request.headers);
  try {
    const result = await getEngagement(engagementDeps(), { slug, session });
    if (!result.ok) return json(result, STATUS[result.kind]);
    return json({ ...result, signIn: readerSignInAvailable(), me: session ? { name: session.n } : null });
  } catch (err) {
    console.error(`reader: loading engagement failed: ${err instanceof Error ? err.message : "unknown"}`);
    return json({ ok: false, error: "Likes and comments could not be loaded." }, 500);
  }
}