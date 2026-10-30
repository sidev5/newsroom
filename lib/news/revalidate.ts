import "server-only";
import { revalidatePath, revalidateTag } from "next/cache";
import { STORIES_TAG } from "./cache-tag";

/**
 * Drops the cached homepage, article pages and story data now, so an approved, unpublished, restored or edited
 * story shows (or disappears) on the next visit instead of after the 60 s revalidate. Call it from a server
 * action or route handler after the database change succeeded.
 *
 * { expire: 0 } means no stale copy is served while the page is rebuilt: the next request waits for fresh data.
 */
export function revalidatePublicSite(): void {
  revalidateTag(STORIES_TAG, { expire: 0 });
  revalidatePath("/");
  revalidatePath("/article/[slug]", "page");
}
