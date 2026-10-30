import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MODEL_PRICES_USD_PER_MTOK, PIPELINE_DEFAULTS } from "@/lib/config";
import { schema } from "@/lib/env-schema";
import {
  budgetCost,
  budgetCostOf,
  budgetDay,
  budgetDayStart,
  budgetMessage,
  createBudgetGuard,
  fallbackPrice,
  loadBudgetState,
  type BudgetStore,
} from "./budget";
import { callAgent, itemAction, LlmTimeoutError, type AgentRun } from "./index";
import type { GenerateRequest, LlmProvider } from "./types";

// BE-04 (daily spend cap) and BE-02 (per-call timeout).

const store = (spent: number, override: { limit_usd: number; raised_by: string } | null = null): BudgetStore & { spentSince: ReturnType<typeof vi.fn> } => ({
  spentSince: vi.fn(async () => spent),
  override: vi.fn(async () => (override ? { ...override, created_at: "2026-10-16T05:00:00Z" } : null)),
});

describe("the budget day (Asia/Kolkata)", () => {
  it("changes at 18:30 UTC, which is midnight in India", () => {
    expect(budgetDay(new Date("2026-10-16T18:29:59Z"))).toBe("2026-10-16");
    expect(budgetDay(new Date("2026-10-16T18:30:00Z"))).toBe("2026-10-17");
    expect(budgetDay(new Date("2026-10-16T00:00:00Z"))).toBe("2026-10-16");
    expect(budgetDay(new Date("2026-12-31T20:00:00Z"))).toBe("2027-01-01");
  });

  it("starts the day at 18:30 UTC of the day before", () => {
    expect(budgetDayStart("2026-10-16").toISOString()).toBe("2026-10-15T18:30:00.000Z");
    expect(budgetDayStart("2027-01-01").toISOString()).toBe("2026-12-31T18:30:00.000Z");
  });
});

describe("what a call costs", () => {
  it("uses the price table for a priced model (and its dated variants)", () => {
    // claude-sonnet-5-5: $2 in, $10 out per million tokens
    expect(budgetCost({ model: "claude-sonnet-5-5", input_tokens: 1_000_000, output_tokens: 100_000 })).toBeCloseTo(3);
    expect(budgetCost({ model: "claude-haiku-4-5-20251001", input_tokens: 2_000_000, output_tokens: 0 })).toBeCloseTo(2);
  });

  it("counts a model with no price at the highest known price, never as free", () => {
    const fb = fallbackPrice();
    expect(fb.input).toBe(Math.max(...Object.values(MODEL_PRICES_USD_PER_MTOK).map((p) => p.input)));
    expect(fb.output).toBe(Math.max(...Object.values(MODEL_PRICES_USD_PER_MTOK).map((p) => p.output)));
    const unpriced = budgetCost({ model: "gemini-3.8-flash", input_tokens: 1_000_000, output_tokens: 1_000_000 });
    expect(unpriced).toBeCloseTo((fb.input + fb.output) * 1);
    expect(unpriced).toBeGreaterThan(0);
  });

  it("sums many calls", () => {
    const runs = [
      { model: "claude-sonnet-5-5", input_tokens: 500_000, output_tokens: 0 },
      { model: "claude-sonnet-5-5", input_tokens: 500_000, output_tokens: 0 },
    ];
    expect(budgetCostOf(runs)).toBeCloseTo(2);
    expect(budgetCostOf([])).toBe(0);
  });
});

describe("the limit in force today", () => {
  it("is DAILY_BUDGET_USD without an override, and the cap is reached at exactly the limit", async () => {
    const now = new Date("2026-10-16T06:00:00Z");
    expect(await loadBudgetState(store(1.99), now, 2)).toMatchObject({ day: "2026-10-16", limitUsd: 2, raisedBy: null, exceeded: false });
    expect(await loadBudgetState(store(2), now, 2)).toMatchObject({ exceeded: true });
    expect(await loadBudgetState(store(5), now, 2)).toMatchObject({ exceeded: true });
  });

  it("is the admin's override when that is higher, and says who raised it", async () => {
    const s = await loadBudgetState(store(2.5, { limit_usd: 4, raised_by: "editor@example.com" }), new Date("2026-10-16T06:00:00Z"), 2);
    expect(s).toMatchObject({ limitUsd: 4, baseLimitUsd: 2, raisedBy: "editor@example.com", exceeded: false });
  });

  it("ignores an override that is not higher than the configured limit", async () => {
    const s = await loadBudgetState(store(0, { limit_usd: 1, raised_by: "editor@example.com" }), new Date("2026-10-16T06:00:00Z"), 2);
    expect(s).toMatchObject({ limitUsd: 2, raisedBy: null });
  });

  it("asks the store only for today's spend, from midnight IST", async () => {
    const st = store(0);
    await loadBudgetState(st, new Date("2026-10-16T20:00:00Z"), 2); // already 17 Oct in India
    expect(st.spentSince).toHaveBeenCalledWith("2026-10-16T18:30:00.000Z");
  });

  it("has a message with the figures and the reset time", () => {
    const text = budgetMessage({ day: "2026-10-16", spentUsd: 2.031, limitUsd: 2, baseLimitUsd: 2, raisedBy: null, exceeded: true });
    expect(text).toContain("$2.03 of $2.00");
    expect(text).toContain("2026-10-16");
    expect(text).toMatch(/stay queued/);
  });
});

describe("createBudgetGuard", () => {
  const T0 = new Date("2026-10-16T06:00:00Z");

  it("allows calls under the limit and blocks once the limit is reached", async () => {
    const g = createBudgetGuard({ store: store(1), baseLimitUsd: () => 2, now: () => T0 });
    expect(await g.check()).toEqual({ allowed: true });
    const over = createBudgetGuard({ store: store(2.5), baseLimitUsd: () => 2, now: () => T0 });
    expect(await over.check()).toMatchObject({ allowed: false, state: { exceeded: true, spentUsd: 2.5 } });
  });

  it("reads the database once per ttl, not once per call", async () => {
    let t = T0.getTime();
    const st = store(0);
    const g = createBudgetGuard({ store: st, baseLimitUsd: () => 2, now: () => new Date(t), ttlMs: 15_000 });
    await g.check();
    await g.check();
    t += 10_000;
    await g.check();
    expect(st.spentSince).toHaveBeenCalledTimes(1);
    t += 6_000; // 16 s since the load
    await g.check();
    expect(st.spentSince).toHaveBeenCalledTimes(2);
  });

  it("adds the calls this process makes, so the cap holds between reloads", async () => {
    const g = createBudgetGuard({ store: store(1.999), baseLimitUsd: () => 2, now: () => T0 });
    expect(await g.check()).toEqual({ allowed: true });
    g.record({ model: "claude-sonnet-5-5", input_tokens: 10_000, output_tokens: 0 }); // $0.02
    expect(await g.check()).toMatchObject({ allowed: false });
  });

  it("starts again on the next IST day", async () => {
    let t = new Date("2026-10-16T18:00:00Z").getTime();
    const st = store(5);
    const g = createBudgetGuard({ store: st, baseLimitUsd: () => 2, now: () => new Date(t) });
    expect(await g.check()).toMatchObject({ allowed: false });
    t = new Date("2026-10-16T18:31:00Z").getTime(); // 00:01 IST: new day, cached total is for yesterday
    st.spentSince.mockResolvedValueOnce(0.1);
    expect(await g.check()).toEqual({ allowed: true });
    expect(st.spentSince).toHaveBeenLastCalledWith("2026-10-16T18:30:00.000Z");
  });

  it("allows the call, and logs once, when the spend cannot be read", async () => {
    const log = vi.fn();
    const broken: BudgetStore = { spentSince: async () => Promise.reject(new Error("db down")), override: async () => null };
    const g = createBudgetGuard({ store: broken, baseLimitUsd: () => 2, now: () => T0, log });
    expect(await g.check()).toEqual({ allowed: true });
    expect(await g.check()).toEqual({ allowed: true });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/db down/);
  });
});

// ---------------------------------------------------------------------------
// callAgent
// ---------------------------------------------------------------------------

const Schema = z.object({ ok: z.boolean() });

function fakeProvider(generate: (req: GenerateRequest) => Promise<unknown>) {
  const spy = vi.fn(generate);
  const provider: LlmProvider = {
    name: "gemini",
    generate: spy as never,
    classifyError: () => ({ kind: "transient" }),
  };
  return { provider, spy };
}

const answer = (text: string, inputTokens = 100, outputTokens = 50) => ({ text, model: "claude-sonnet-5-5", inputTokens, outputTokens });
const run = (deps: Parameters<typeof callAgent>[1]) => callAgent({ agent: "write", schema: Schema, system: "s", prompt: "p" }, deps);

describe("callAgent and the daily budget", () => {
  const logged: AgentRun[] = [];
  const base = { logRun: async (r: AgentRun) => void logged.push(r), sleep: async () => {} };

  it("sends nothing to the provider once the cap is reached, and leaves the item queued", async () => {
    const { provider, spy } = fakeProvider(async () => answer('{"ok":true}'));
    const budget = createBudgetGuard({ store: store(3), baseLimitUsd: () => 2, now: () => new Date("2026-10-16T06:00:00Z") });
    const result = await run({ ...base, provider, budget });
    expect(result).toMatchObject({ ok: false, reason: "budget_exceeded" });
    expect(result.ok ? "" : result.error).toMatch(/Daily AI spend limit reached: \$3\.00 of \$2\.00/);
    expect(spy).not.toHaveBeenCalled();
    expect(itemAction(result)).toBe("leave_and_stop"); // not "fail": the item is not marked failed
  });

  it("works normally under the cap, and adds what the call cost to the running total", async () => {
    const { provider, spy } = fakeProvider(async () => answer('{"ok":true}', 1_000_000, 0)); // $2 on sonnet
    const budget = createBudgetGuard({ store: store(0), baseLimitUsd: () => 2, now: () => new Date("2026-10-16T06:00:00Z") });
    expect(await run({ ...base, provider, budget })).toMatchObject({ ok: true });
    expect(spy).toHaveBeenCalledTimes(1);
    // that call used the whole day's allowance: the next one is refused
    expect(await run({ ...base, provider, budget })).toMatchObject({ ok: false, reason: "budget_exceeded" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not make the validation retry once the first answer used up the cap", async () => {
    const { provider, spy } = fakeProvider(async () => answer("not json", 1_000_000, 0));
    const budget = createBudgetGuard({ store: store(0), baseLimitUsd: () => 2, now: () => new Date("2026-10-16T06:00:00Z") });
    const result = await run({ ...base, provider, budget });
    expect(result).toMatchObject({ ok: false, reason: "budget_exceeded" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("budget: null turns the cap off", async () => {
    const { provider } = fakeProvider(async () => answer('{"ok":true}'));
    expect(await run({ ...base, provider, budget: null })).toMatchObject({ ok: true });
  });
});

describe("callAgent and the per-call timeout (BE-02)", () => {
  const base = { logRun: async () => {}, sleep: vi.fn(async () => {}) };

  it("gives up on a call that never answers: provider_error, one attempt, no backoff, item left queued", async () => {
    const { provider, spy } = fakeProvider(() => new Promise(() => {}));
    const sleep = vi.fn(async () => {});
    const logRun = vi.fn(async () => {});
    const started = Date.now();
    const result = await run({ ...base, sleep, logRun, provider, budget: null, timeoutMs: 40 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result).toMatchObject({ ok: false, reason: "provider_error" });
    expect(result.ok ? "" : result.error).toMatch(/timed out after/);
    expect(spy).toHaveBeenCalledTimes(1); // a retry would wait a whole timeout again
    expect(sleep).not.toHaveBeenCalled();
    expect(logRun).not.toHaveBeenCalled(); // nothing came back, nothing was paid for
    expect(itemAction(result)).toBe("leave_and_stop");
  });

  it("a call that answers in time is not affected", async () => {
    const { provider } = fakeProvider(() => new Promise((resolve) => setTimeout(() => resolve(answer('{"ok":true}')), 10)));
    expect(await run({ ...base, provider, budget: null, timeoutMs: 500 })).toMatchObject({ ok: true });
  });

  it("tells the provider its own (longer) timeout, so a stuck connection is freed too", async () => {
    const { provider, spy } = fakeProvider(async () => answer('{"ok":true}'));
    await run({ ...base, provider, budget: null, timeoutMs: 45_000 });
    expect(spy.mock.calls[0][0].timeoutMs).toBe(50_000);
  });

  it("a provider that rejects with its own timeout error is still retried like any transient error", async () => {
    let n = 0;
    const { provider, spy } = fakeProvider(async () => {
      if (++n === 1) throw new Error("socket hang up");
      return answer('{"ok":true}');
    });
    const sleep = vi.fn(async () => {});
    expect(await run({ ...base, sleep, provider, budget: null, timeoutMs: 500 })).toMatchObject({ ok: true });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("LlmTimeoutError reads well in a log line", () => {
    expect(new LlmTimeoutError(45_000).message).toBe("timed out after 45s");
  });
});

describe("the new settings", () => {
  const parse = (extra: Record<string, string>) =>
    schema.parse({
      NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "a",
      SUPABASE_SERVICE_ROLE_KEY: "s",
      CRON_SECRET: "0123456789abcdef",
      ...extra,
    });

  it("default to 45 s and $2 a day", () => {
    const e = parse({});
    expect(e.LLM_TIMEOUT_MS).toBe(PIPELINE_DEFAULTS.LLM_TIMEOUT_MS);
    expect(e.LLM_TIMEOUT_MS).toBe(45_000);
    expect(e.DAILY_BUDGET_USD).toBe(2);
  });

  it("can be configured, and an empty value means the default", () => {
    expect(parse({ LLM_TIMEOUT_MS: "20000", DAILY_BUDGET_USD: "7.5" })).toMatchObject({ LLM_TIMEOUT_MS: 20_000, DAILY_BUDGET_USD: 7.5 });
    expect(parse({ DAILY_BUDGET_USD: "" }).DAILY_BUDGET_USD).toBe(2);
  });

  it("refuse nonsense", () => {
    expect(() => parse({ DAILY_BUDGET_USD: "0" })).toThrow();
    expect(() => parse({ DAILY_BUDGET_USD: "-3" })).toThrow();
    expect(() => parse({ LLM_TIMEOUT_MS: "100" })).toThrow();
    expect(() => parse({ LLM_TIMEOUT_MS: "abc" })).toThrow();
  });
});
