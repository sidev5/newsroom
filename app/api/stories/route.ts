import type { NextRequest } from "next/server";
import { FEED_PAGE_SIZE, getFeedPage } from "@/lib/news/queries";

export const dynamic = "force-dynamic";

/** The oldest page that can be asked for: 10 000 stories. Beyond it the feed ends. */
const MAX_OFFSET = 10_000;

/**
 * "Load more" for the feed: GET /api/stories?offset=60. Public data only, behind the 60 s data cache.
 * The page size is fixed and the offset must be a multiple of it, so the number of distinct cached pages (and of
 * database queries a caller can cause) is bounded.
 */
export async function GET(request: NextRequest) {
  const offset = Number(request.nextUrl.searchParams.get("offset") ?? 0);
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET || offset % FEED_PAGE_SIZE !== 0) {
    return Response.json({ error: "Bad offset." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  try {
    return Response.json(await getFeedPage(offset, FEED_PAGE_SIZE), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error(`Loading more stories failed: ${err instanceof Error ? err.message : String(err)}`);
    return Response.json({ error: "Stories could not be loaded." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
