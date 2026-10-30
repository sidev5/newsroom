import { describe, expect, it } from "vitest";
import { departmentTabs, filterStories, matchesQuery, plottable } from "./filter";
import { defaultImagePath, departmentStyle } from "./departments";
import { isoDate, paragraphs, relativeTime, safeHttpUrl, sourceName, summarize } from "./format";
import type { Story } from "./types";

const story = (over: Partial<Story> & { id: string }): Story => ({
  slug: over.id,
  headline: "Headline",
  body: "Body",
  summary: "Body",
  department: { name: "EV", slug: "ev" },
  place: null,
  lat: null,
  lon: null,
  country_code: null,
  country_name: null,
  source_urls: [],
  source_published_at: null,
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

const stories = [
  story({ id: "1", headline: "Charging network expands", place: "Oslo, Norway", lat: 59.9, lon: 10.7 }),
  story({ id: "2", headline: "Solid-state cell breakthrough", department: { name: "Batteries", slug: "batteries" }, place: "Tokyo", lat: 35.7, lon: 139.7 }),
  story({ id: "3", headline: "Defence contract awarded", department: { name: "Defence", slug: "defence" }, place: null }),
  story({ id: "4", headline: "New EV launch in Oslo", place: "Oslo, Norway", lat: 59.9, lon: 10.7 }),
  story({ id: "5", headline: "Orphan story", department: null }),
];

describe("filterStories", () => {
  it("returns everything with no filters", () => {
    expect(filterStories(stories, { department: null, query: "" })).toHaveLength(5);
  });

  it("filters by department slug", () => {
    expect(filterStories(stories, { department: "ev", query: "" }).map((s) => s.id)).toEqual(["1", "4"]);
    expect(filterStories(stories, { department: "software", query: "" })).toEqual([]);
  });

  it("searches headline and place, case-insensitively, ignoring surrounding spaces", () => {
    expect(filterStories(stories, { department: null, query: "  CHARGING " }).map((s) => s.id)).toEqual(["1"]);
    expect(filterStories(stories, { department: null, query: "oslo" }).map((s) => s.id)).toEqual(["1", "4"]);
    expect(filterStories(stories, { department: null, query: "tokyo" }).map((s) => s.id)).toEqual(["2"]);
  });

  it("does not search the body or department name", () => {
    expect(filterStories([story({ id: "x", body: "secret phrase" })], { department: null, query: "secret" })).toEqual([]);
    expect(filterStories(stories, { department: null, query: "batteries" })).toEqual([]);
  });

  it("combines department and query", () => {
    expect(filterStories(stories, { department: "ev", query: "oslo" }).map((s) => s.id)).toEqual(["1", "4"]);
    expect(filterStories(stories, { department: "batteries", query: "oslo" })).toEqual([]);
  });

  it("keeps stories without a place in play for headline searches", () => {
    expect(matchesQuery({ headline: "Hello", place: null }, "hel")).toBe(true);
    expect(matchesQuery({ headline: "Hello", place: null }, "oslo")).toBe(false);
  });
});

describe("map markers follow the same filter", () => {
  it("only plots filtered stories that have valid coordinates", () => {
    const filtered = filterStories(stories, { department: null, query: "oslo" });
    expect(plottable(filtered).map((s) => s.id)).toEqual(["1", "4"]);
    expect(plottable(stories).map((s) => s.id)).toEqual(["1", "2", "4"]);
    expect(plottable([story({ id: "b", lat: 120, lon: 0 }), story({ id: "c", lat: 0, lon: 0 })]).map((s) => s.id)).toEqual(["c"]);
  });
});

describe("departmentTabs", () => {
  it("counts per department for the current query, sorted by name", () => {
    const { all, tabs } = departmentTabs(stories, "");
    expect(all).toBe(5);
    expect(tabs).toEqual([
      { slug: "batteries", name: "Batteries", count: 1 },
      { slug: "defence", name: "Defence", count: 1 },
      { slug: "ev", name: "EV", count: 2 },
    ]);
  });

  it("keeps every department as a tab but counts only matches", () => {
    const { all, tabs } = departmentTabs(stories, "oslo");
    expect(all).toBe(2);
    expect(tabs.find((t) => t.slug === "ev")?.count).toBe(2);
    expect(tabs.find((t) => t.slug === "batteries")?.count).toBe(0);
  });
});

describe("department styling", () => {
  it("matches by slug and falls back to deep sage", () => {
    expect(departmentStyle("ev")).toEqual({ chip: "#99CDD8", dot: "#2E7D6E" });
    expect(departmentStyle("sales-marketing").dot).toBe("#5F7A3A");
    expect(departmentStyle("new-dept").dot).toBe("#657166");
    expect(departmentStyle(null).dot).toBe("#657166");
  });

  it("picks the department default image, else the generic one", () => {
    expect(defaultImagePath("batteries")).toBe("/images/defaults/batteries.svg");
    expect(defaultImagePath("new-dept")).toBe("/images/defaults/default.svg");
    expect(defaultImagePath(null)).toBe("/images/defaults/default.svg");
  });
});

describe("format helpers", () => {
  it("formats dates the same everywhere", () => {
    expect(isoDate("2026-10-12T23:59:59Z")).toBe("2026-10-12");
    expect(isoDate(null)).toBeNull();
    expect(isoDate("nonsense")).toBeNull();
  });

  it("formats relative time from a supplied clock", () => {
    const now = new Date("2026-10-12T12:00:00Z").getTime();
    expect(relativeTime("2026-10-12T11:59:40Z", now)).toBe("JUST NOW");
    expect(relativeTime("2026-10-12T11:15:00Z", now)).toBe("45M AGO");
    expect(relativeTime("2026-10-12T07:00:00Z", now)).toBe("5H AGO");
    expect(relativeTime("2026-10-09T12:00:00Z", now)).toBe("3D AGO");
    expect(relativeTime("2026-09-01T12:00:00Z", now)).toBe("2026-09-01");
    expect(relativeTime(null, now)).toBe("");
  });

  it("derives a source name and only allows web links", () => {
    expect(sourceName("https://www.reuters.com/a/b")).toBe("reuters.com");
    expect(sourceName("not a url")).toBe("");
    expect(safeHttpUrl("https://x.example.com/a")).toBe("https://x.example.com/a");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });

  it("summarises at a word boundary and splits paragraphs", () => {
    expect(summarize("short")).toBe("short");
    const s = summarize("word ".repeat(100), 50);
    expect(s.endsWith("…")).toBe(true);
    expect(s.length).toBeLessThanOrEqual(51);
    expect(paragraphs("One.\n\nTwo.\nThree.\n\n\n")).toEqual(["One.", "Two.", "Three."]);
  });
});
