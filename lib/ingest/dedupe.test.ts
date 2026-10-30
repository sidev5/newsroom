import { describe, expect, it } from "vitest";
import { planInserts } from "./dedupe";
import type { FeedItem } from "./rss";

const item = (n: number): FeedItem => ({ url: `https://x.example.com/${n}`, title: `T${n}`, content: "", publishedAt: null });

describe("planInserts", () => {
  it("skips URLs already in the database", () => {
    const plan = planInserts([item(1), item(2), item(3)], [item(2).url], 10);
    expect(plan.toInsert.map((i) => i.url)).toEqual([item(1).url, item(3).url]);
    expect(plan.duplicates).toBe(1);
    expect(plan.deferred).toBe(0);
  });

  it("skips URLs repeated within the same feed", () => {
    const plan = planInserts([item(1), item(1), item(2)], [], 10);
    expect(plan.toInsert.map((i) => i.url)).toEqual([item(1).url, item(2).url]);
    expect(plan.duplicates).toBe(1);
  });

  it("limits new items per source and defers the rest", () => {
    const plan = planInserts([item(1), item(2), item(3), item(4), item(5)], [item(1).url], 3);
    expect(plan.toInsert.map((i) => i.url)).toEqual([item(2).url, item(3).url, item(4).url]);
    expect(plan.duplicates).toBe(1);
    expect(plan.deferred).toBe(1);
  });

  it("does not count duplicates against the limit", () => {
    const plan = planInserts([item(1), item(2), item(3), item(4)], [item(1).url, item(2).url], 2);
    expect(plan.toInsert).toHaveLength(2);
    expect(plan.deferred).toBe(0);
  });

  it("handles an all-duplicate feed", () => {
    const plan = planInserts([item(1), item(2)], [item(1).url, item(2).url], 3);
    expect(plan).toEqual({ toInsert: [], duplicates: 2, deferred: 0 });
  });
});
