import { describe, expect, it } from "vitest";
import { FACTCHECK_FRESHNESS_RULES, formatSourceDate, isTooOld, sourceAttribution } from "./freshness";
import { buildWritePrompt, WRITE_SYSTEM } from "./write";

const now = new Date("2026-10-12T12:00:00Z");

describe("isTooOld", () => {
  it("is true only beyond the max age", () => {
    expect(isTooOld("2026-10-09T11:59:00Z", 3, now)).toBe(true);
    expect(isTooOld("2026-10-09T12:00:00Z", 3, now)).toBe(false); // exactly 3 days
    expect(isTooOld("2026-10-11T00:00:00Z", 3, now)).toBe(false);
  });

  it("does not treat unknown or invalid dates as too old", () => {
    expect(isTooOld(null, 3, now)).toBe(false);
    expect(isTooOld(undefined, 3, now)).toBe(false);
    expect(isTooOld("garbage", 3, now)).toBe(false);
  });
});

describe("source attribution", () => {
  it("formats the date in UTC", () => {
    expect(formatSourceDate("2026-10-10T23:30:00Z")).toBe("10 October 2026");
    expect(sourceAttribution("2026-10-10T08:00:00Z")).toBe("Based on a source published 10 October 2026");
  });

  it("says so when the date is unknown", () => {
    expect(formatSourceDate(null)).toBeNull();
    expect(sourceAttribution(null)).toBe("Based on a source (publication date unknown)");
  });
});

describe("prompts", () => {
  it("gives the writer the source date, or 'unknown'", () => {
    const base = { title: "T", content: "C", full_text: null };
    expect(buildWritePrompt({ ...base, source_published_at: "2026-10-10T08:00:00Z" })).toContain(
      "Source publication date: 10 October 2026",
    );
    expect(buildWritePrompt({ ...base, source_published_at: null })).toContain("Source publication date: unknown");
  });

  it("requires time-bound phrasing and bans unsupported 'remains'/'still'", () => {
    expect(WRITE_SYSTEM).toContain("as of <source date>");
    expect(WRITE_SYSTEM).toContain("at the time of publication");
    expect(WRITE_SYSTEM).toMatch(/Never say that something "remains", "still"/);
  });

  it("gives the fact-checker the freshness rules", () => {
    expect(FACTCHECK_FRESHNESS_RULES).toMatch(/Current-status claims without a date/);
    expect(FACTCHECK_FRESHNESS_RULES).toMatch(/generalising from one market/);
  });
});
