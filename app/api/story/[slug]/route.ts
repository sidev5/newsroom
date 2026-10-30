import type { NextRequest } from "next/server";
import { getStoryBySlug } from "@/lib/news/queries";

export const dynamic = "force-dynamic";

// Slugs are made of lowercase letters, digits and dashes (see slugify in the pipeline and the submission form).
const SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/;

/** The full story (with its body) for the reader: GET /api/story/<slug>. 404 when it is missing or not published. */
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/story/[slug]">) {
  const { slug } = await ctx.params;
  if (!SLUG.test(slug)) return Response.json({ error: "Not found." }, { status: 404, headers: { "Cache-Control": "no-store" } });
  try {
    const story = await getStoryBySlug(slug);
    if (!story) return Response.json({ error: "Not found." }, { status: 404, headers: { "Cache-Control": "no-store" } });
    return Response.json(story, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error(`Loading story failed: ${err instanceof Error ? err.message : String(err)}`);
    return Response.json({ error: "The story could not be loaded." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
