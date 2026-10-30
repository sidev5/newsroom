import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { runIngest, type IngestDeps, type Source } from "./ingest";
import { progressOf, runStage } from "./stages";
import type { RunRecord, RunStore } from "./run-log";

// BE-01: ingest stops starting work at the stage deadline, like the other stages, and says what it left.

beforeEach(() => {
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    CRON_SECRET: "test-secret-0123456789",
    FETCH_TIMEOUT_MS: "10000",
    MAX_ITEMS_PER_FEED: "15",
  });
  resetEnvCache();
});

const source = (n: number): Source => ({ id: `s${n}`, name: `Source ${n}`, rss_url: `https://feed${n}.example.com/rss`, department_id: "d1" });

/** An RSS feed whose items were published a minute ago. */
function feed(sourceNo: number, items: number): string {
  const when = new Date(Date.now() - 60_000).toUTCString();
  const entries = Array.from(
    { length: items },
    (_, i) => `<item><title>Story ${sourceNo}.${i}</title><link>https://site${sourceNo}.example.com/story-${i}</link><description>About story ${i}</description><pubDate>${when}</pubDate></item>`,
  ).join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${entries}</channel></rss>`;
}

type Harness = { deps: Partial<IngestDeps>; stored: string[]; requested: { url: string; timeoutMs: number }[]; clock: { t: number } };

/**
 * A fake network that costs `cost` ms of the (fake) clock per request. Feeds are the URLs on feedN.example.com; any other
 * URL is an article page.
 */
function harness(sources: Source[], itemsPerFeed: number, cost: number, existing: string[] = []): Harness {
  const clock = { t: 1_000_000 };
  const stored: string[] = [];
  const requested: Harness["requested"] = [];
  const deps: Partial<IngestDeps> = {
    sources: async () => sources,
    existingUrls: async (urls) => urls.filter((u) => existing.includes(u)),
    insertItem: async (item) => {
      stored.push(item.url);
      return true;
    },
    robotsAllowed: async () => true,
    fetchText: async (url, opts) => {
      requested.push({ url, timeoutMs: opts.timeoutMs });
      clock.t += cost;
      const m = /^https:\/\/feed(\d+)\./.exec(url);
      return m ? feed(Number(m[1]), itemsPerFeed) : "<html><body><article><p>Page text of the story, long enough to be useful to the writer.</p></article></body></html>";
    },
  };
  return { deps, stored, requested, clock };
}

describe("runIngest without a deadline", () => {
  it("stores every new item of every feed and reports nothing deferred", async () => {
    const h = harness([source(1), source(2)], 3, 0);
    const r = await runIngest({ now: () => h.clock.t }, h.deps);
    expect(h.stored).toHaveLength(6);
    expect(r.totals).toMatchObject({ fetched: 6, inserted: 6, deferred: 0, sourcesDeferred: 0, failed: 0 });
    expect(r.stopped).toBeNull();
  });

  it("still defers what is over MAX_ITEMS_PER_FEED, and that is not a time stop", async () => {
    process.env.MAX_ITEMS_PER_FEED = "2";
    resetEnvCache();
    const h = harness([source(1)], 5, 0);
    const r = await runIngest({}, h.deps);
    expect(r.totals).toMatchObject({ inserted: 2, deferred: 3 });
    expect(r.stopped).toBeNull();
  });
});

describe("runIngest with a deadline", () => {
  it("starts no feed at all when the time is already up, and says how many it left", async () => {
    const h = harness([source(1), source(2), source(3)], 3, 0);
    const r = await runIngest({ deadlineAt: h.clock.t - 1, now: () => h.clock.t }, h.deps);
    expect(h.requested).toEqual([]);
    expect(h.stored).toEqual([]);
    expect(r.totals).toMatchObject({ inserted: 0, sourcesDeferred: 3 });
    expect(r.stopped).toBe("time_budget");
  });

  it("stops in the middle of a feed: the items it did not reach are deferred, not lost and not failed", async () => {
    // Every request takes 20 s; the deadline is 50 s away. Feed (20 s), item 1 page (40 s), item 2 page (60 s): the time is up.
    const h = harness([source(1)], 5, 20_000);
    const r = await runIngest({ deadlineAt: h.clock.t + 50_000, now: () => h.clock.t }, h.deps);
    expect(r.totals).toMatchObject({ fetched: 5, inserted: 2, deferred: 3, failed: 0, sourcesDeferred: 0 });
    expect(h.stored).toHaveLength(2);
    expect(r.stopped).toBe("time_budget");
    // what was left is picked up by the next run: those URLs are simply not stored
    expect(h.stored).not.toContain("https://site1.example.com/story-4");
  });

  it("finishes early feeds and defers the feeds it never reached", async () => {
    // One worker lane at a time is not guaranteed, so make the feeds slow: 4 run at once, the fifth waits for a free lane.
    const sources = [1, 2, 3, 4, 5].map(source);
    const h = harness(sources, 1, 30_000);
    const r = await runIngest({ deadlineAt: h.clock.t + 25_000, now: () => h.clock.t }, h.deps);
    // The first requests of the four lanes run before anyone checks the clock again; later work is refused.
    expect(r.totals.sourcesDeferred).toBeGreaterThanOrEqual(1);
    expect(r.stopped).toBe("time_budget");
    expect(r.sources).toHaveLength(5);
  });

  it("does not let a request run past the deadline: the timeout is cut to the time left (but never below 1 s)", async () => {
    const h = harness([source(1)], 1, 0);
    // 3 s left, FETCH_TIMEOUT_MS is 10 s
    await runIngest({ deadlineAt: h.clock.t + 3_000, now: () => h.clock.t }, h.deps);
    expect(h.requested.map((r) => r.timeoutMs)).toEqual([3000, 3000]); // the feed and the one article page

    const h2 = harness([source(1)], 1, 0);
    await runIngest({ deadlineAt: h2.clock.t + 200, now: () => h2.clock.t }, h2.deps);
    expect(Math.min(...h2.requested.map((r) => r.timeoutMs))).toBe(1000);

    const h3 = harness([source(1)], 1, 0);
    await runIngest({ deadlineAt: h3.clock.t + 120_000, now: () => h3.clock.t }, h3.deps);
    expect(h3.requested.map((r) => r.timeoutMs)).toEqual([10_000, 10_000]); // plenty of time: the normal timeout
  });

  it("an item whose page cannot be fetched is still stored, from the feed summary", async () => {
    const h = harness([source(1)], 1, 0);
    h.deps.fetchText = async (url) => {
      if (url.includes("feed1")) return feed(1, 1);
      throw new Error("HTTP 500");
    };
    const r = await runIngest({}, h.deps);
    expect(r.totals).toMatchObject({ inserted: 1, fullText: 0, failed: 0 });
  });

  it("a feed that fails is counted as failed and does not stop the others", async () => {
    const h = harness([source(1), source(2)], 2, 0);
    const inner = h.deps.fetchText!;
    h.deps.fetchText = async (url, opts) => {
      if (url.includes("feed1")) throw new Error("HTTP 503");
      return inner(url, opts);
    };
    const r = await runIngest({}, h.deps);
    expect(r.totals).toMatchObject({ failed: 1, inserted: 2 });
    expect(r.sources[0].error).toMatch(/feed: HTTP 503/);
  });
});

describe("a time-limited ingest is reported and recorded like any other run", () => {
  it("progressOf shows the stop and the items left", () => {
    const p = progressOf("ingest", { totals: { inserted: 2, deferred: 3, tooOld: 0, failed: 0, sourcesDeferred: 1 }, stopped: "time_budget" });
    expect(p).toMatchObject({ processed: 2, remaining: 3, stopped: "time_budget", rateLimited: false });
    expect(progressOf("ingest", { totals: { inserted: 2, deferred: 0 } }).stopped).toBeNull();
  });

  it("runStage records a pipeline_runs row, ok, with the summary that says it stopped for time", async () => {
    const saved: RunRecord[] = [];
    const store: RunStore = {
      acquire: async () => ({ ok: true, handle: { id: "run-1" } }),
      finish: async (_h, record) => {
        saved.push(record);
        return "run-1";
      },
      recent: async () => [],
      markAlerted: async () => {},
    };
    const summary = { processed: 2, remaining: 3, stopped: "time_budget" };
    await runStage("ingest", "cron", { store, run: async () => summary, now: () => new Date("2026-10-16T05:00:00Z") });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ stage: "ingest", ok: true, error: null, triggered_by: "cron", summary });
  });
});

describe("the ingest stage runner passes the stage deadline", () => {
  it("calls runIngest with deadlineAt = now + STAGE_TIME_BUDGET_MS, or the caller's own deadline", async () => {
    vi.resetModules();
    const runIngestMock = vi.fn(async () => ({ totals: { inserted: 0, deferred: 0, tooOld: 0, failed: 0 }, sources: [], stopped: null }));
    vi.doMock("./ingest", () => ({ runIngest: runIngestMock }));
    vi.doMock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({}) }));
    process.env.STAGE_TIME_BUDGET_MS = "30000";
    resetEnvCache();
    const { STAGE_RUNNERS } = await import("./stages");

    const before = Date.now();
    await STAGE_RUNNERS.ingest({});
    const after = Date.now();
    const first = (runIngestMock.mock.calls[0] as unknown as [{ deadlineAt: number }])[0].deadlineAt;
    expect(first).toBeGreaterThanOrEqual(before + 30_000);
    expect(first).toBeLessThanOrEqual(after + 30_000);

    await STAGE_RUNNERS.ingest({ deadlineAt: 12345 });
    expect((runIngestMock.mock.calls[1] as unknown as [{ deadlineAt: number }])[0].deadlineAt).toBe(12345);

    delete process.env.STAGE_TIME_BUDGET_MS;
    vi.doUnmock("./ingest");
    vi.doUnmock("@/lib/supabase/admin");
    resetEnvCache();
  });
});
