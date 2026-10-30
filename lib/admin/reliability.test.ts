import { describe, expect, it, vi } from "vitest";
import type { BudgetState } from "@/lib/llm/budget";
import type { RecentRun } from "@/lib/pipeline/run-log";
import { failingStages } from "./alerts";
import { MAX_LIMIT_USD, parseDollars, raiseTodaysLimit, type RaiseDeps } from "./budget-admin";
import { bannerFromSearch, bannerParams, errorCodeFor } from "./messages";

// BE-04 (raising today's limit), BE-06 (the banner for a stage that keeps failing) and the wording of both.

const state = (over: Partial<BudgetState> = {}): BudgetState => ({ day: "2026-10-16", spentUsd: 2.1, limitUsd: 2, baseLimitUsd: 2, raisedBy: null, exceeded: true, ...over });

function deps(over: Partial<RaiseDeps> & { admin?: string | null; current?: BudgetState } = {}) {
  const inserted: unknown[][] = [];
  const log = vi.fn();
  const after = vi.fn();
  const d: RaiseDeps = {
    adminEmail: async () => (over.admin === undefined ? "editor@example.com" : over.admin),
    state: async () => over.current ?? state(),
    insert: async (...args) => void inserted.push(args),
    after,
    log,
  };
  return { d, inserted, log, after };
}

describe("parseDollars", () => {
  it.each([
    ["5", 5],
    ["5.5", 5.5],
    ["$7.25", 7.25],
    [" 12 ", 12],
    ["1,000", 1000],
    [4, 4],
    ["0.5", 0.5],
  ])("reads %j as %d", (input, expected) => {
    expect(parseDollars(input)).toBe(expected);
  });

  it.each(["", "abc", "0", "-3", "1e3", "5.555", "5,5,5x", "NaN", "Infinity", null, undefined, {}, "5 dollars"])("refuses %j", (input) => {
    expect(parseDollars(input)).toBeNull();
  });
});

describe("raiseTodaysLimit", () => {
  it("is for admins only, and stores nothing otherwise", async () => {
    const t = deps({ admin: null });
    expect(await raiseTodaysLimit("5", t.d)).toEqual({ ok: false, error: "Not authorised." });
    expect(t.inserted).toEqual([]);
    expect(t.log).not.toHaveBeenCalled();
  });

  it("raises the limit, stores who did it and what it replaced, and logs it", async () => {
    const t = deps();
    expect(await raiseTodaysLimit("5", t.d)).toEqual({ ok: true, limit: 5, previous: 2 });
    expect(t.inserted).toEqual([["2026-10-16", 5, "editor@example.com", 2]]);
    expect(t.log).toHaveBeenCalledTimes(1);
    expect(t.log.mock.calls[0][0]).toBe("budget: editor@example.com raised the limit for 2026-10-16 from $2.00 to $5.00 (spent so far $2.10)");
    expect(t.after).toHaveBeenCalledTimes(1);
  });

  it("must be higher than the limit in force: equal and lower are refused", async () => {
    for (const amount of ["2", "1.5", "0.5"]) {
      const t = deps();
      const r = await raiseTodaysLimit(amount, t.d);
      expect(r, amount).toMatchObject({ ok: false, error: "The new limit must be higher than today's limit ($2.00)." });
      expect(t.inserted).toEqual([]);
    }
  });

  it("a second raise has to beat the first one", async () => {
    const t = deps({ current: state({ limitUsd: 5, raisedBy: "editor@example.com" }) });
    expect(await raiseTodaysLimit("4", t.d)).toMatchObject({ ok: false });
    expect(await raiseTodaysLimit("8", t.d)).toEqual({ ok: true, limit: 8, previous: 5 });
  });

  it("refuses an amount that is not a positive number of dollars", async () => {
    for (const input of ["", "abc", "-5", "0", "1e9"]) {
      const t = deps();
      expect(await raiseTodaysLimit(input, t.d), input).toEqual({ ok: false, error: "Enter an amount in dollars, for example 5." });
      expect(t.inserted).toEqual([]);
    }
  });

  it("refuses a typo that would remove the cap", async () => {
    const t = deps();
    const r = await raiseTodaysLimit("5000", t.d);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("highest limit") });
    expect(t.inserted).toEqual([]);
    expect(MAX_LIMIT_USD).toBe(1000);
    expect(await raiseTodaysLimit("1000", t.d)).toMatchObject({ ok: true });
  });

  it("checks the admin before it reads anything", async () => {
    const stateFn = vi.fn(async () => state());
    const insert = vi.fn(async () => {});
    await raiseTodaysLimit("5", { adminEmail: async () => null, state: stateFn, insert });
    expect(stateFn).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
});

describe("the banner for a stage that keeps failing", () => {
  const run = (ok: boolean, over: Partial<RecentRun> = {}): RecentRun => ({ id: `r${Math.random()}`, ok, error: ok ? null : "provider down", finished_at: "2026-10-16T05:00:00Z", alert_sent: false, ...over });

  it("lists stages with two or more failures in a row, and only those", async () => {
    const history: Record<string, RecentRun[]> = {
      ingest: [run(true)],
      classify: [run(false), run(true), run(false)], // one since the last success
      write: [run(false, { error: "quota" }), run(false, { alert_sent: true })],
      image: [run(false), run(false), run(false)],
      factcheck: [],
    };
    const streaks = await failingStages({ recent: async (stage) => history[stage] });
    expect(streaks.map((s) => [s.stage, s.count])).toEqual([["write", 2], ["image", 3]]);
    expect(streaks[0]).toMatchObject({ lastError: "quota", alerted: true });
    expect(streaks[1].alerted).toBe(false);
  });

  it("leaves out a stage whose history cannot be read instead of failing the page", async () => {
    const streaks = await failingStages({
      recent: async (stage) => {
        if (stage === "write") throw new Error("db down");
        return [run(false), run(false)];
      },
    });
    expect(streaks.map((s) => s.stage)).toEqual(["ingest", "classify", "image", "factcheck"]);
  });

  it("shows nothing when everything works", async () => {
    expect(await failingStages({ recent: async () => [run(true), run(false)] })).toEqual([]);
  });
});

describe("wording (the URL carries codes only)", () => {
  it("maps the new messages to fixed codes", () => {
    const log = vi.fn();
    expect(errorCodeFor("Enter an amount in dollars, for example 5.", log)).toBe("budget_invalid");
    expect(errorCodeFor("The new limit must be higher than today's limit ($2.00).", log)).toBe("budget_not_higher");
    expect(errorCodeFor("That is more than the highest limit that can be set ($1000.00).", log)).toBe("budget_too_high");
    expect(errorCodeFor("This digest has been sending for less than 15 minutes, so it is not stuck yet. Wait, then try again.", log)).toBe("digest_not_stuck");
    expect(errorCodeFor("Only a digest that is stuck in sending can be marked as failed (this one is sent).", log)).toBe("digest_not_sending");
    expect(errorCodeFor("Only a failed digest can be retried (this one is draft).", log)).toBe("digest_not_failed");
    expect(errorCodeFor("This digest is no longer sending.", log)).toBe("digest_changed");
    expect(errorCodeFor("This digest is no longer failed: reload and check it.", log)).toBe("digest_changed");
    expect(log).not.toHaveBeenCalled(); // none fell through to "generic"
  });

  it("shows the notices without taking text from the URL", () => {
    expect(bannerFromSearch({ notice: "budget_raised" })).toEqual({ kind: "ok", text: "Today's AI spend limit was raised. Paused stages can run again." });
    expect(bannerFromSearch(bannerParams({ notice: "digest_marked_failed", n: 42 }))).toEqual({
      kind: "ok",
      text: expect.stringContaining("Marked as failed after 42 minutes in sending."),
    });
    expect(bannerFromSearch({ error: "budget_not_higher" })).toMatchObject({ kind: "problem", text: "The new limit must be higher than today's limit." });
    expect(bannerFromSearch({ error: "<script>alert(1)</script>", notice: "<b>x</b>" })).toBeNull();
  });
});
