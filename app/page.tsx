import { Dashboard } from "@/components/dashboard/Dashboard";
import { getFeedPage } from "@/lib/news/queries";
import type { FeedPage } from "@/lib/news/types";

// Cached for 60 s; approving, unpublishing, restoring or editing a story drops the cache at once (lib/news/revalidate.ts).
export const revalidate = 60;

export default async function Home() {
  let page: FeedPage = { stories: [], hasMore: false };
  let failed = false;
  try {
    page = await getFeedPage();
  } catch (err) {
    console.error(`Loading stories failed: ${err instanceof Error ? err.message : String(err)}`);
    failed = true;
  }

  return (
    <>
      {failed && (
        <p role="alert" className="bg-blush px-4 py-2 text-center text-[14px] text-ink">
          Stories could not be loaded right now. Please try again in a moment.
        </p>
      )}
      <Dashboard page={page} />
    </>
  );
}
