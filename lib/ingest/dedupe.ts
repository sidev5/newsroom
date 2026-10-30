import { isTooOld } from "@/lib/pipeline/freshness";
import type { FeedItem } from "./rss";

export type FeedSelection = {
  /** Items to consider, newest first. Undated items follow the dated ones, in feed order. */
  items: FeedItem[];
  /** Dropped because the source was published more than maxAgeDays ago. */
  tooOld: number;
};

/** Newest first, minus items older than maxAgeDays. Items with no date are kept (their age is unknown). */
export function selectFeedItems(items: FeedItem[], maxAgeDays: number, now: Date = new Date()): FeedSelection {
  const recent = items.filter((i) => !isTooOld(i.publishedAt, maxAgeDays, now));
  const time = (i: FeedItem) => (i.publishedAt ? new Date(i.publishedAt).getTime() : NaN);
  const dated = recent.filter((i) => Number.isFinite(time(i))).sort((a, b) => time(b) - time(a));
  const undated = recent.filter((i) => !Number.isFinite(time(i)));
  return { items: [...dated, ...undated], tooOld: items.length - recent.length };
}

export type InsertPlan = {
  /** New items to insert this run, in the order given, at most `limit`. */
  toInsert: FeedItem[];
  /** Already in the DB, or repeated within the feed. */
  duplicates: number;
  /** New but over the per-source limit; picked up on a later run. */
  deferred: number;
};

export function planInserts(items: FeedItem[], existingUrls: Iterable<string>, limit: number): InsertPlan {
  const seen = new Set(existingUrls);
  const fresh: FeedItem[] = [];
  let duplicates = 0;
  for (const item of items) {
    if (seen.has(item.url)) {
      duplicates++;
      continue;
    }
    seen.add(item.url);
    fresh.push(item);
  }
  return {
    toInsert: fresh.slice(0, limit),
    duplicates,
    deferred: Math.max(0, fresh.length - limit),
  };
}
