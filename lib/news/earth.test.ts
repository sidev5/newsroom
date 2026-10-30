import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COUNTRIES } from "@/lib/geo/countries";
import { COUNTRY_POLYGON_IDS } from "@/lib/geo/country-ids";
import { tint } from "./color";
import { FEED_CHIPS, feedChips } from "./filter";
import { globeDiameter, openScale, readerWidth } from "./layout";
import type { Story } from "./types";

describe("tint", () => {
  it("is the base at 0 and the colour at 1, and mixes in between", () => {
    expect(tint("#2E7D6E", "#F3EBDC", 0)).toBe("#f3ebdc");
    expect(tint("#2E7D6E", "#F3EBDC", 1)).toBe("#2e7d6e");
    expect(tint("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  it("clamps the strength and survives bad input", () => {
    expect(tint("#000000", "#ffffff", 5)).toBe("#000000");
    expect(tint("#000000", "#ffffff", -1)).toBe("#ffffff");
    expect(tint("not a colour", "#F3EBDC", 0.5)).toBe("#f3ebdc");
    expect(tint("#2E7D6E", "bad", 0.5)).toBe("bad");
  });

  it("makes a country with news a lighter version of its department colour than the colour itself", () => {
    const light = tint("#B4573A", "#F3EBDC", 0.38);
    const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
    for (const i of [0, 1, 2]) expect(channel(light, i)).toBeGreaterThanOrEqual(Math.min(channel("#B4573A", i), channel("#F3EBDC", i)));
    expect(light).not.toBe("#f3ebdc"); // visibly tinted
  });
});

describe("globe and reader sizes", () => {
  it("globe diameter is min(640, 78% of the height, 92% of the width)", () => {
    expect(globeDiameter(1200, 900)).toBe(640);
    expect(globeDiameter(1200, 600)).toBeCloseTo(468);
    expect(globeDiameter(500, 900)).toBeCloseTo(460);
    expect(globeDiameter(0, 0)).toBe(0);
  });

  it("reader is min(540px, 70% of the area)", () => {
    expect(readerWidth(1000)).toBe(540);
    expect(readerWidth(600)).toBeCloseTo(420);
  });

  it("with the reader open the globe fits the free strip, within 0.3-0.8", () => {
    expect(openScale(1600, 900)).toBe(0.8); // plenty of room
    const s = openScale(880, 600); // 1280px wide screen
    expect(s).toBeGreaterThanOrEqual(0.3);
    expect(s).toBeLessThan(0.8);
    expect(globeDiameter(880, 600) * s).toBeLessThanOrEqual(880 - readerWidth(880));
    expect(openScale(300, 900)).toBe(0.3); // almost no free strip: floor
  });
});

const story = (id: string, slug: string | null, headline = "H"): Story => ({
  id, slug: id, headline, body: "b", summary: "b",
  department: slug ? { name: slug, slug } : null,
  place: null, lat: null, lon: null, country_code: null, country_name: null,
  source_urls: [], source_published_at: null, published_at: null,
  image_url: null, image_credit: null, image_credit_url: null, image_alt: null,
  origin: "ai", author_first_name: null, author_last_name: null, author_department: null,
});

describe("feedChips", () => {
  it("lists the chips in the fixed order, World last among them", () => {
    expect(FEED_CHIPS.map((c) => c.label)).toEqual(["EV", "Batteries", "Defence", "Software", "Sales & Marketing", "AI & Technology", "World"]);
    expect(feedChips([], "").chips.map((c) => c.slug)).toEqual(FEED_CHIPS.map((c) => c.slug));
  });

  it("counts per chip and for All, including World as just another chip", () => {
    const stories = [story("1", "ev"), story("2", "ev"), story("3", "world"), story("4", "defence"), story("5", null)];
    const { all, chips } = feedChips(stories, "");
    expect(all).toBe(5);
    expect(Object.fromEntries(chips.map((c) => [c.slug, c.count]))).toEqual({
      ev: 2, batteries: 0, defence: 1, software: 0, "sales-marketing": 0, "ai-technology": 0, world: 1,
    });
  });

  it("counts only stories matching the search", () => {
    const stories = [story("1", "ev", "Charging network"), story("2", "world", "Charging ban"), story("3", "ev", "Other")];
    const { all, chips } = feedChips(stories, "charging");
    expect(all).toBe(2);
    expect(chips.find((c) => c.slug === "ev")!.count).toBe(1);
    expect(chips.find((c) => c.slug === "world")!.count).toBe(1);
  });

  it("adds a department outside the list after the fixed chips", () => {
    const { chips } = feedChips([story("1", "legal")], "");
    expect(chips.at(-1)).toMatchObject({ slug: "legal", count: 1 });
    expect(chips).toHaveLength(FEED_CHIPS.length + 1);
  });
});

describe("country polygon ids", () => {
  type Atlas = { objects: { countries: { geometries: { id?: string | number; properties: { name: string } }[] } } };
  const atlas = JSON.parse(readFileSync(new URL("../../node_modules/world-atlas/countries-110m.json", import.meta.url), "utf8")) as Atlas;
  const byId = new Map(atlas.objects.countries.geometries.map((g) => [String(g.id), g.properties.name]));

  it("only uses codes that are in the country map", () => {
    for (const code of Object.keys(COUNTRY_POLYGON_IDS)) expect(COUNTRIES).toHaveProperty(code);
  });

  it("points every code at a polygon that exists in the atlas, one country per polygon", () => {
    const ids = Object.values(COUNTRY_POLYGON_IDS);
    for (const id of ids) expect(byId.has(id)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("maps well-known countries to the right polygon", () => {
    const name = (code: string) => byId.get(COUNTRY_POLYGON_IDS[code]);
    expect(name("US")).toBe("United States of America");
    expect(name("DE")).toBe("Germany");
    expect(name("IN")).toBe("India");
    expect(name("CD")).toBe("Dem. Rep. Congo");
    expect(name("GB")).toBe("United Kingdom");
    expect(name("MK")).toMatch(/Macedonia/);
  });

  it("leaves microstates without a polygon rather than drawing a neighbour", () => {
    for (const code of ["AD", "SG", "MC", "MT", "VA"]) expect(COUNTRY_POLYGON_IDS[code]).toBeUndefined();
  });
});
