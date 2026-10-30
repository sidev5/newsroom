import { describe, expect, it } from "vitest";
import { planInserts, selectFeedItems } from "./dedupe";
import type { FeedItem } from "./rss";

const NOW = new Date("2026-10-15T12:00:00Z");
const item = (n: number, publishedAt: string | null): FeedItem => ({ url: `https://e.com/${n}`, title: `Item ${n}`, content: "c", publishedAt });
const days = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

describe("selectFeedItems", () => {
  it("orders newest first, whatever the feed order", () => {
    const { items } = selectFeedItems([item(1, days(2)), item(2, days(0.1)), item(3, days(1))], 3, NOW);
    expect(items.map((i) => i.url)).toEqual(["https://e.com/2", "https://e.com/3", "https://e.com/1"]);
  });

  it("drops items older than MAX_ITEM_AGE_DAYS and counts them", () => {
    const sel = selectFeedItems([item(1, days(1)), item(2, days(5)), item(3, days(3.5))], 3, NOW);
    expect(sel.items.map((i) => i.url)).toEqual(["https://e.com/1"]);
    expect(sel.tooOld).toBe(2);
  });

  it("keeps undated items (age unknown) after the dated ones, in feed order", () => {
    const { items, tooOld } = selectFeedItems([item(1, null), item(2, days(2)), item(3, null), item(4, days(1))], 3, NOW);
    expect(items.map((i) => i.url)).toEqual(["https://e.com/4", "https://e.com/2", "https://e.com/1", "https://e.com/3"]);
    expect(tooOld).toBe(0);
  });
});

describe("per-feed cap (MAX_ITEMS_PER_FEED)", () => {
  it("takes the 15 newest new items and defers the rest; duplicates and old items are skipped first", () => {
    // 30 items, one per hour, newest is #0; the feed lists them oldest first. #0-#2 already stored.
    const feed = Array.from({ length: 30 }, (_, n) => item(n, new Date(NOW.getTime() - n * 3_600_000).toISOString())).reverse();
    const old = item(99, days(10));
    const { items, tooOld } = selectFeedItems([...feed, old], 3, NOW);
    const existing = ["https://e.com/0", "https://e.com/1", "https://e.com/2"];
    const plan = planInserts(items, existing, 15);
    expect(tooOld).toBe(1);
    expect(plan.duplicates).toBe(3);
    expect(plan.toInsert).toHaveLength(15);
    expect(plan.toInsert[0].url).toBe("https://e.com/3"); // newest not-yet-stored
    expect(plan.toInsert[14].url).toBe("https://e.com/17");
    expect(plan.deferred).toBe(30 - 3 - 15);
  });
});
