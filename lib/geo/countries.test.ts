import { describe, expect, it, vi } from "vitest";
import { callAgent, type CallAgentParams, type CallAgentResult } from "@/lib/llm";
import type { LlmProvider } from "@/lib/llm/types";
import { writeItem, writeSchema, type WriteItem } from "@/lib/pipeline/write";
import { COUNTRIES, countryByCode, normalizeCountryCode, resolveCountry } from "./countries";

describe("country map", () => {
  it("has only valid alpha-2 codes and in-range coordinates", () => {
    for (const [code, c] of Object.entries(COUNTRIES)) {
      expect(code).toMatch(/^[A-Z]{2}$/);
      expect(c.name.length).toBeGreaterThan(1);
      expect(Math.abs(c.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(c.lon)).toBeLessThanOrEqual(180);
    }
    expect(Object.keys(COUNTRIES).length).toBeGreaterThan(190);
  });

  it("looks up by code", () => {
    expect(countryByCode("de")).toMatchObject({ code: "DE", name: "Germany" });
    expect(countryByCode("ZZ")).toBeNull();
    expect(countryByCode(null)).toBeNull();
  });
});

describe("normalizeCountryCode", () => {
  it("accepts known codes in any case, trimmed", () => {
    expect(normalizeCountryCode("us")).toBe("US");
    expect(normalizeCountryCode(" GB ")).toBe("GB");
  });

  it.each([["UK"], ["XX"], ["USA"], [""], ["  "], ["__proto__"], ["constructor"], [null], [undefined], [42], [{}]])(
    "rejects %j instead of guessing",
    (value) => {
      expect(normalizeCountryCode(value)).toBeNull();
    },
  );
});

describe("resolveCountry", () => {
  it("prefers the model's valid code", () => {
    expect(resolveCountry("fr", "DE")).toEqual({ code: "FR", name: "France", from: "model" });
  });

  it("falls back to the source's country when the model code is missing or invalid", () => {
    expect(resolveCountry(null, "DE")).toEqual({ code: "DE", name: "Germany", from: "source" });
    expect(resolveCountry(undefined, "de")).toMatchObject({ code: "DE", from: "source" });
    expect(resolveCountry("ZZ", "DE")).toMatchObject({ code: "DE", from: "source" });
    expect(resolveCountry("Atlantis", "DE")).toMatchObject({ code: "DE", from: "source" });
  });

  it("returns null, never an invented country, when neither is valid", () => {
    expect(resolveCountry(null, null)).toBeNull();
    expect(resolveCountry("ZZ", "QQ")).toBeNull();
    expect(resolveCountry("ZZ", undefined)).toBeNull();
  });
});

// ---- Through the write agent ---------------------------------------------------------------

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
const base = { headline: "Parliament passes budget", body: words(200), image_query: "parliament", image_alt: "A parliament building" };

const item: WriteItem = {
  id: "11111111-aaaa",
  url: "https://example.com/story",
  title: "Budget passed",
  content: words(200),
  full_text: null,
  source_published_at: "2026-10-13T08:00:00.000Z",
  department_id: "d-world",
  place: null,
  lat: null,
  lon: null,
  source_country_code: null,
};

function agentReplying(reply: unknown) {
  const provider: LlmProvider = {
    name: "gemini",
    generate: vi.fn(async () => ({ text: JSON.stringify(reply), model: "fake", inputTokens: 1, outputTokens: 1 })),
    classifyError: () => ({ kind: "fatal" }),
  };
  return <T>(p: CallAgentParams<T>): Promise<CallAgentResult<T>> =>
    callAgent(p, { provider, logRun: async () => {}, sleep: async () => {} });
}

async function articleFor(reply: unknown, over: Partial<WriteItem> = {}) {
  const d = await writeItem({ ...item, ...over }, { minSourceWords: 120 }, agentReplying(reply));
  if (d.kind !== "write") throw new Error(`expected a draft, got ${d.kind}`);
  return d.article;
}

describe("write agent country output", () => {
  it("schema accepts a code, null, or no field at all", () => {
    expect(writeSchema.safeParse({ ...base, country_code: "DE" }).success).toBe(true);
    expect(writeSchema.safeParse({ ...base, country_code: null }).success).toBe(true);
    expect(writeSchema.safeParse(base).success).toBe(true);
    expect(writeSchema.safeParse({ ...base, country_code: 5 }).success).toBe(false);
  });

  it("stores the model's valid country with its name from the static map", async () => {
    expect(await articleFor({ ...base, country_code: "de" })).toMatchObject({ country_code: "DE", country_name: "Germany", place: "Germany" });
  });

  it("drops an invalid model code and falls back to the source's country", async () => {
    const a = await articleFor({ ...base, country_code: "ZZ" }, { source_country_code: "FR" });
    expect(a).toMatchObject({ country_code: "FR", country_name: "France" });
  });

  it("falls back to the source's country when the model gives none", async () => {
    expect(await articleFor({ ...base, country_code: null }, { source_country_code: "IN" })).toMatchObject({ country_code: "IN" });
  });

  it("leaves the country empty when nothing valid is available, and does not invent a place", async () => {
    const a = await articleFor({ ...base, country_code: "ZZ" }, { source_country_code: "QQ" });
    expect(a).toMatchObject({ country_code: null, country_name: null, place: null });
  });

  it("keeps the source's own place when it has one", async () => {
    const a = await articleFor({ ...base, country_code: "US" }, { place: "Columbus, Ohio" });
    expect(a).toMatchObject({ place: "Columbus, Ohio", country_code: "US" });
  });
});
