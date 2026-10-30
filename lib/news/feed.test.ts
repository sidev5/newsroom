import { describe, expect, it } from "vitest";
import { appendUnique, mergeFeed, resolveReader } from "./feed";
import type { FeedStory, Story } from "./types";

const feed = (id: string, over: Partial<FeedStory> = {}): FeedStory => ({
  id,
  slug: `slug-${id}`,
  headline: `Headline ${id}`,
  summary: `Summary ${id}`,
  department: null,
  place: null,
  lat: null,
  lon: null,
  country_code: null,
  country_name: null,
  source_urls: [],
  published_at: null,
  image_url: null,
  image_credit: null,
  image_credit_url: null,
  image_alt: null,
  origin: "ai",
  author_first_name: null,
  author_last_name: null,
  author_department: null,
  ...over,
});
const full = (id: string): Story => ({ ...feed(id), body: `Full body ${id}`, source_published_at: "2026-10-10T00:00:00.000Z" });
const ids = (list: FeedStory[]) => list.map((s) => s.id);

describe("mergeFeed / appendUnique (Load more)", () => {
  it("appends the next page after the first", () => {
    expect(ids(mergeFeed([feed("1"), feed("2")], [feed("3"), feed("4")]))).toEqual(["1", "2", "3", "4"]);
  });

  it("never lists a story twice when a newly published story shifted the pages", () => {
    expect(ids(mergeFeed([feed("1"), feed("2")], [feed("2"), feed("3")]))).toEqual(["1", "2", "3"]);
    expect(ids(appendUnique([feed("5"), feed("6")], [feed("6"), feed("7")]))).toEqual(["5", "6", "7"]);
  });

  it("keeps the order of the pages and does not mutate its inputs", () => {
    const first = [feed("1")];
    const extra = [feed("2")];
    mergeFeed(first, extra);
    expect(first).toHaveLength(1);
    expect(extra).toHaveLength(1);
  });

  it("handles empty pages", () => {
    expect(mergeFeed([], [])).toEqual([]);
    expect(ids(mergeFeed([feed("1")], []))).toEqual(["1"]);
  });
});

describe("resolveReader", () => {
  it("shows nothing when no story is selected", () => {
    expect(resolveReader({ slug: null, inFeed: null, full: undefined, failure: null }).story).toBeNull();
  });

  it("opens at once from the card, with the summary and no body, while the body loads", () => {
    const card = feed("1");
    const r = resolveReader({ slug: card.slug, inFeed: card, full: undefined, failure: null });
    expect(r.status).toBe("loading");
    expect(r.story).toBe(card);
    expect(r.story?.body).toBeUndefined();
  });

  it("switches to the full story when it has arrived", () => {
    const card = feed("1");
    const r = resolveReader({ slug: card.slug, inFeed: card, full: full("1"), failure: null });
    expect(r.status).toBe("ready");
    expect(r.story?.body).toBe("Full body 1");
  });

  it("a deep link to a story that is not in the loaded list waits for the fetch", () => {
    const r = resolveReader({ slug: "slug-99", inFeed: null, full: undefined, failure: null });
    expect(r).toEqual({ story: null, status: "loading" });
    expect(resolveReader({ slug: "slug-99", inFeed: null, full: full("99"), failure: null })).toMatchObject({ status: "ready", story: { id: "99" } });
  });

  it("a 404 hides the stale card: an unpublished story must not stay readable from the list", () => {
    const card = feed("1");
    const r = resolveReader({ slug: card.slug, inFeed: card, full: undefined, failure: { slug: card.slug, kind: "missing" } });
    expect(r).toEqual({ story: null, status: "missing" });
  });

  it("a failed fetch keeps the card and says so", () => {
    const card = feed("1");
    const r = resolveReader({ slug: card.slug, inFeed: card, full: undefined, failure: { slug: card.slug, kind: "error" } });
    expect(r.story).toBe(card);
    expect(r.status).toBe("error");
  });

  it("a failure of another story does not affect this one", () => {
    const card = feed("1");
    const r = resolveReader({ slug: card.slug, inFeed: card, full: undefined, failure: { slug: "slug-2", kind: "missing" } });
    expect(r.status).toBe("loading");
    expect(r.story).toBe(card);
  });
});