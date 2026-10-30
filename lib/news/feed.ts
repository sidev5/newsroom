import type { FeedStory, ReaderStatus, ReaderStory, Story } from "./types";

// The state rules of the dashboard that need no DOM: appending pages of the feed and deciding what the reader shows.

/** The first page followed by the stories loaded since, without a story twice (a new story shifts the pages). */
export function mergeFeed(first: FeedStory[], extra: FeedStory[]): FeedStory[] {
  const seen = new Set(first.map((s) => s.id));
  return [...first, ...extra.filter((s) => !seen.has(s.id))];
}

/** `next` added to `prev`, skipping ids that are already there. */
export function appendUnique(prev: FeedStory[], next: FeedStory[]): FeedStory[] {
  const have = new Set(prev.map((s) => s.id));
  return [...prev, ...next.filter((s) => !have.has(s.id))];
}

export type ReaderFailure = { slug: string; kind: "missing" | "error" } | null;

/**
 * What the reader shows for the slug in the address bar.
 * - the full story once it has been fetched ("ready");
 * - until then the feed card's story, with its summary in place of the body ("loading");
 * - for a deep link to a story that is not in the loaded list: nothing yet ("loading", story null);
 * - "missing" when the server says the story does not exist or is no longer published: the stale card is not shown;
 * - "error" when the fetch failed (the card, if there is one, stays visible).
 */
export function resolveReader(args: { slug: string | null; inFeed: FeedStory | null; full: Story | undefined; failure: ReaderFailure }): {
  story: ReaderStory | null;
  status: ReaderStatus;
} {
  const { slug, inFeed, full, failure } = args;
  if (!slug) return { story: null, status: "loading" };
  const failed = failure?.slug === slug ? failure.kind : null;
  if (failed === "missing") return { story: null, status: "missing" };
  if (full) return { story: full, status: "ready" };
  return { story: inFeed, status: failed ?? "loading" };
}
