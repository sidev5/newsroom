import { describe, expect, it } from "vitest";
import { countryByCode } from "@/lib/geo/countries";
import { departmentStyle } from "./departments";
import {
  activeCountry,
  badgeLabel,
  groupByCountry,
  HOVER_EASING,
  HOVER_MS,
  HOVER_SCALE,
  hoverReducer,
  markerLayer,
  markerScale,
  needsReveal,
  NO_HOVER,
  pausesRotation,
  tooltipCountry,
  tooltipFor,
  type HoverState,
} from "./markers";
import type { Story } from "./types";

const story = (id: string, over: Partial<Story> = {}): Story => ({
  id,
  slug: id,
  headline: `Headline ${id}`,
  body: "Body",
  summary: "Body",
  department: { name: "EV", slug: "ev", kind: "company" },
  place: null,
  lat: null,
  lon: null,
  country_code: "DE",
  country_name: "Germany",
  source_urls: [],
  source_published_at: null,
  published_at: "2026-10-14T08:00:00Z",
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

const world = { name: "World", slug: "world", kind: "world" as const };

describe("groupByCountry", () => {
  it("makes one marker per country, positioned from the static map", () => {
    const groups = groupByCountry([story("1"), story("2"), story("3", { country_code: "FR" })]);
    expect(groups.map((g) => [g.code, g.count])).toEqual([["DE", 2], ["FR", 1]]);
    const de = countryByCode("DE")!;
    expect(groups[0]).toMatchObject({ lat: de.lat, lon: de.lon, name: "Germany" });
  });

  it("orders each country's stories newest first", () => {
    const [g] = groupByCountry([
      story("old", { published_at: "2026-10-10T00:00:00Z" }),
      story("new", { published_at: "2026-10-14T00:00:00Z" }),
      story("mid", { published_at: "2026-10-12T00:00:00Z" }),
    ]);
    expect(g.stories.map((s) => s.id)).toEqual(["new", "mid", "old"]);
  });

  it("skips stories without a valid country rather than placing them", () => {
    const groups = groupByCountry([story("1", { country_code: null }), story("2", { country_code: "ZZ" }), story("3", { country_code: "gb" })]);
    expect(groups.map((g) => g.code)).toEqual(["GB"]);
  });

  it("colours by department, and world stories with the neutral world colour", () => {
    const [ev] = groupByCountry([story("1")]);
    expect(ev.color).toBe(departmentStyle("ev").dot);
    const [w] = groupByCountry([story("2", { department: world, country_code: "FR" })]);
    expect(w.color).toBe(departmentStyle("world").dot);
    expect(w.departmentSlug).toBe("world");
    // A mixed country takes the newest story's colour.
    const [mixed] = groupByCountry([
      story("a", { department: world, published_at: "2026-10-14T10:00:00Z" }),
      story("b", { published_at: "2026-10-13T10:00:00Z" }),
    ]);
    expect(mixed.color).toBe(departmentStyle("world").dot);
  });

  it("returns nothing for no stories", () => {
    expect(groupByCountry([])).toEqual([]);
  });
});

describe("hover state", () => {
  it("emphasises a marker on enter and releases it on leave", () => {
    let s = hoverReducer(NO_HOVER, { type: "marker-enter", code: "DE" });
    expect(activeCountry(s)).toBe("DE");
    expect(markerScale("DE", s)).toBe(HOVER_SCALE);
    expect(markerScale("FR", s)).toBe(1);
    s = hoverReducer(s, { type: "marker-leave", code: "DE" });
    expect(activeCountry(s)).toBeNull();
    expect(markerScale("DE", s)).toBe(1);
  });

  it("uses a 1 -> 1.5 scale over 180ms with ease-out", () => {
    expect(HOVER_SCALE).toBe(1.5);
    expect(HOVER_MS).toBe(180);
    expect(HOVER_EASING).toBe("ease-out");
  });

  it("ignores a leave or blur for a country that is not the current one", () => {
    let s = hoverReducer(NO_HOVER, { type: "marker-enter", code: "DE" });
    s = hoverReducer(s, { type: "marker-enter", code: "FR" }); // pointer moved straight to another marker
    s = hoverReducer(s, { type: "marker-leave", code: "DE" }); // late leave for the old one
    expect(activeCountry(s)).toBe("FR");
  });

  it("emphasises on keyboard focus and releases on blur", () => {
    let s = hoverReducer(NO_HOVER, { type: "focus", code: "IN" });
    expect(markerScale("IN", s)).toBe(HOVER_SCALE);
    expect(tooltipCountry(s)).toBe("IN");
    s = hoverReducer(s, { type: "blur", code: "IN" });
    expect(activeCountry(s)).toBeNull();
  });

  it("scales for a hovered feed card but opens no tooltip", () => {
    const s = hoverReducer(NO_HOVER, { type: "card-enter", code: "BR" });
    expect(markerScale("BR", s)).toBe(HOVER_SCALE);
    expect(tooltipCountry(s)).toBeNull();
    expect(activeCountry(hoverReducer(s, { type: "card-leave", code: "BR" }))).toBeNull();
  });

  it("gives a direct marker hover priority over focus, and focus over a card", () => {
    const s: HoverState = { marker: "A1", focus: "B1", card: "C1" };
    expect(activeCountry(s)).toBe("A1");
    expect(activeCountry({ ...s, marker: null })).toBe("B1");
    expect(activeCountry({ ...s, marker: null, focus: null })).toBe("C1");
    expect(tooltipCountry({ ...s, marker: null })).toBe("B1");
  });

  it("repeated enter events keep the same state object", () => {
    const s = hoverReducer(NO_HOVER, { type: "marker-enter", code: "DE" });
    expect(hoverReducer(s, { type: "marker-enter", code: "DE" })).toBe(s);
  });

  it("raises the emphasised marker above the others", () => {
    const s = hoverReducer(NO_HOVER, { type: "marker-enter", code: "DE" });
    expect(markerLayer("DE", s, false)).toBe("z-30");
    expect(markerLayer("FR", s, true)).toBe("z-10");
    expect(markerLayer("FR", s, false)).toBe("z-0");
    expect(markerLayer("DE", NO_HOVER, false)).toBe("z-0");
  });

  it("pauses auto-rotation while any marker is emphasised", () => {
    expect(pausesRotation(NO_HOVER)).toBe(false);
    expect(pausesRotation({ ...NO_HOVER, marker: "DE" })).toBe(true);
    expect(pausesRotation({ ...NO_HOVER, focus: "DE" })).toBe(true);
    expect(pausesRotation({ ...NO_HOVER, card: "DE" })).toBe(true);
  });
});

describe("far side of the globe", () => {
  it("turns the globe only when the country is hidden or near the limb", () => {
    expect(needsReveal(1)).toBe(false);
    expect(needsReveal(0.5)).toBe(false);
    expect(needsReveal(0.15)).toBe(false);
    expect(needsReveal(0.1)).toBe(true);
    expect(needsReveal(0)).toBe(true);
    expect(needsReveal(-0.8)).toBe(true);
  });
});

describe("tooltip and badge", () => {
  it("shows the country name and up to 3 headlines, with a count of the rest", () => {
    const stories = ["1", "2", "3", "4", "5"].map((id) => story(id));
    expect(tooltipFor({ name: "Germany", stories })).toEqual({
      title: "Germany",
      headlines: ["Headline 1", "Headline 2", "Headline 3"],
      more: 2,
    });
    expect(tooltipFor({ name: "Germany", stories: stories.slice(0, 2) })).toMatchObject({ headlines: ["Headline 1", "Headline 2"], more: 0 });
  });

  it("shows a count badge only above one story", () => {
    expect(badgeLabel(1)).toBeNull();
    expect(badgeLabel(2)).toBe("2");
    expect(badgeLabel(150)).toBe("99+");
  });
});
