import { describe, expect, it, vi } from "vitest";
import { makeSummary } from "@/lib/news/format";
import { isAdminEmail } from "./auth";
import { aggregateCosts, priceFor, runCost, totals, type RunRow } from "./costs";
import { approveArticle, rejectArticle, saveArticleEdits, type ReviewDeps } from "./review";

// ---------------------------------------------------------------------------
// Admin check
// ---------------------------------------------------------------------------
describe("isAdminEmail", () => {
  const list = ["editor@example.com", "admin@example.com"];
  it("matches case-insensitively and ignores whitespace", () => {
    expect(isAdminEmail("Editor@Example.com", list)).toBe(true);
    expect(isAdminEmail("  admin@example.com ", list)).toBe(true);
  });
  it("rejects others, empty values and an empty list", () => {
    expect(isAdminEmail("eve@example.com", list)).toBe(false);
    expect(isAdminEmail("", list)).toBe(false);
    expect(isAdminEmail(null, list)).toBe(false);
    expect(isAdminEmail(undefined, list)).toBe(false);
    expect(isAdminEmail("editor@example.com", [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Review actions
// ---------------------------------------------------------------------------
const NOW = new Date("2026-10-12T09:30:00.000Z");

function deps(admin: string | null, changed = 1) {
  const update = vi.fn<ReviewDeps["update"]>(async () => changed);
  const unpublish = vi.fn<ReviewDeps["unpublish"]>(async () => changed);
  const log = vi.fn<ReviewDeps["log"]>(async () => {});
  const d: ReviewDeps = { adminEmail: async () => admin, update, unpublish, log, now: () => NOW };
  return { d, update, unpublish, log };
}

describe("review actions: admin check", () => {
  it.each([
    ["approve", (d: ReviewDeps) => approveArticle("a1", { headline: "H", body: "B" }, d)],
    ["reject", (d: ReviewDeps) => rejectArticle("a1", d)],
    ["save", (d: ReviewDeps) => saveArticleEdits("a1", { headline: "H", body: "B" }, d)],
  ])("%s never touches the database for a non-admin", async (_name, act) => {
    const { d, update } = deps(null);
    expect(await act(d)).toEqual({ ok: false, error: "Not authorised." });
    expect(update).not.toHaveBeenCalled();
  });
});

describe("approveArticle", () => {
  it("publishes with published_at and saves the edited text in the same update", async () => {
    const { d, update } = deps("editor@example.com");
    expect(await approveArticle("a1", { headline: "  New headline ", body: " Edited body " }, d)).toEqual({ ok: true });
    expect(update).toHaveBeenCalledWith("a1", {
      status: "published",
      published_at: "2026-10-12T09:30:00.000Z",
      headline: "New headline",
      body: "Edited body",
      summary: "Edited body", // the card summary follows the edited body
    });
  });

  it("recomputes the 240-character summary from an edited body, so the feed card matches what is published", async () => {
    const { d, update } = deps("editor@example.com");
    const body = "word ".repeat(200);
    await approveArticle("a1", { headline: "H", body }, d);
    const patch = update.mock.calls[0][1] as { summary: string; body: string };
    expect(patch.summary).toBe(makeSummary(body));
    expect(patch.summary.length).toBeLessThanOrEqual(241);
    expect(patch.summary.endsWith("…")).toBe(true);
  });

  it("publishes without touching the text when no edits are passed", async () => {
    const { d, update } = deps("editor@example.com");
    await approveArticle("a1", undefined, d);
    expect(update).toHaveBeenCalledWith("a1", { status: "published", published_at: "2026-10-12T09:30:00.000Z" });
  });

  it("refuses an empty headline or body and writes nothing", async () => {
    const { d, update } = deps("editor@example.com");
    expect(await approveArticle("a1", { headline: " ", body: "B" }, d)).toMatchObject({ ok: false });
    expect(await approveArticle("a1", { headline: "H", body: "" }, d)).toMatchObject({ ok: false });
    expect(update).not.toHaveBeenCalled();
  });

  it("reports an article that is no longer pending (0 rows changed)", async () => {
    const { d } = deps("editor@example.com", 0);
    expect(await approveArticle("a1", { headline: "H", body: "B" }, d)).toEqual({
      ok: false,
      error: "This article is no longer pending review.",
    });
  });

  it("returns a database error instead of throwing", async () => {
    const { d, update } = deps("editor@example.com");
    update.mockRejectedValueOnce(new Error("db down"));
    expect(await approveArticle("a1", { headline: "H", body: "B" }, d)).toEqual({ ok: false, error: "Update failed: db down" });
  });

  it("needs an id", async () => {
    const { d, update } = deps("editor@example.com");
    expect(await approveArticle("", undefined, d)).toMatchObject({ ok: false });
    expect(update).not.toHaveBeenCalled();
  });
});

describe("rejectArticle and saveArticleEdits", () => {
  it("reject sets only status 'rejected'", async () => {
    const { d, update } = deps("editor@example.com");
    expect(await rejectArticle("a1", d)).toEqual({ ok: true });
    expect(update).toHaveBeenCalledWith("a1", { status: "rejected" });
  });

  it("save updates headline and body only, leaving status alone (nothing is re-run)", async () => {
    const { d, update } = deps("editor@example.com");
    expect(await saveArticleEdits("a1", { headline: "H", body: "B" }, d)).toEqual({ ok: true });
    expect(update).toHaveBeenCalledWith("a1", { headline: "H", body: "B", summary: "B" });
  });

  it("save rejects invalid edits", async () => {
    const { d, update } = deps("editor@example.com");
    expect(await saveArticleEdits("a1", { headline: "x".repeat(201), body: "B" }, d)).toMatchObject({ ok: false });
    expect(update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Costs
// ---------------------------------------------------------------------------
describe("costs", () => {
  const prices = { "model-a": { input: 1, output: 5 }, "model-a-pro": { input: 10, output: 50 } };
  const run = (over: Partial<RunRow> = {}): RunRow => ({
    agent: "classify",
    model: "model-a",
    input_tokens: 1_000_000,
    output_tokens: 200_000,
    created_at: "2026-10-12T10:00:00Z",
    ...over,
  });

  it("prices per million tokens", () => {
    expect(runCost(run(), prices)).toBeCloseTo(1 + 1); // 1M*1 + 0.2M*5
  });

  it("matches versioned model names by the longest configured prefix", () => {
    expect(priceFor("model-a-20260101", prices)).toEqual(prices["model-a"]);
    expect(priceFor("model-a-pro-preview", prices)).toEqual(prices["model-a-pro"]);
    expect(priceFor("other", prices)).toBeUndefined();
    expect(runCost(run({ model: "other" }), prices)).toBeNull();
  });

  it("groups by UTC day and agent, newest day first, and sums tokens", () => {
    const rows = aggregateCosts(
      [
        run(),
        run({ input_tokens: 500_000, output_tokens: 0 }),
        run({ agent: "write" }),
        run({ created_at: "2026-10-11T23:59:59Z" }),
        run({ created_at: "2026-10-12T00:00:00Z", agent: "write" }),
      ],
      prices,
    );
    expect(rows.map((r) => `${r.day} ${r.agent} ${r.runs}`)).toEqual([
      "2026-10-12 classify 2",
      "2026-10-12 write 2",
      "2026-10-11 classify 1",
    ]);
    expect(rows[0]).toMatchObject({ inputTokens: 1_500_000, outputTokens: 200_000 });
    expect(rows[0].cost).toBeCloseTo(2.5);
  });

  it("flags unpriced models as a lower bound instead of guessing", () => {
    const rows = aggregateCosts([run(), run({ model: "unknown" })], prices);
    expect(rows[0]).toMatchObject({ runs: 2, unpriced: true });
    expect(rows[0].cost).toBeCloseTo(2); // only the priced run
    expect(totals(rows)).toMatchObject({ runs: 2, unpriced: true });
  });

  it("totals across rows", () => {
    const t = totals(aggregateCosts([run(), run({ agent: "write" })], prices));
    expect(t.runs).toBe(2);
    expect(t.cost).toBeCloseTo(4);
    expect(t.unpriced).toBe(false);
  });
});
