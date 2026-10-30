import { beforeEach, describe, expect, it, vi } from "vitest";
import { PIPELINE_DEFAULTS } from "@/lib/config";
import { env, resetEnvCache } from "@/lib/env";
import type { CallAgentParams, CallAgentResult } from "@/lib/llm";
import { processInChunks, resolveChunkSettings, type ChunkSettings } from "./chunks";
import { runClassify, type ClassifyItem, type Department } from "./classify";
import { runFactcheck, type FactcheckArticle } from "./factcheck";
import { runImage, type ImageArticle } from "./image";
import { ImageSearchError } from "@/lib/images/types";
import type { RunRecord } from "./run-log";
import { progressOf, runStage } from "./stages";
import { runWrite, type WriteItem } from "./write";

type Item = { id: string };
const items = (n: number, from = 0): Item[] => Array.from({ length: n }, (_, i) => ({ id: `i${from + i}` }));

function settings(over: Partial<ChunkSettings> = {}): ChunkSettings & { sleeps: number[] } {
  const sleeps: number[] = [];
  return { limit: 25, chunkSize: 5, delayMs: 1500, deadlineAt: null, sleep: async (ms) => void sleeps.push(ms), now: () => 0, ...over, sleeps };
}

/** A queue whose handled items leave it, like the database. */
function queue(n: number) {
  const q = items(n);
  const asked: number[] = [];
  return {
    asked,
    left: () => q.length,
    load: async (want: number) => {
      asked.push(want);
      return q.slice(0, want);
    },
    take: (handled: Item[]) => handled.forEach((h) => q.splice(q.findIndex((x) => x.id === h.id), 1)),
  };
}

describe("processInChunks", () => {
  it("works through the queue in chunks, pausing between them, until it is empty", async () => {
    const q = queue(12);
    const s = settings();
    const sizes: number[] = [];
    const r = await processInChunks(q.load, s, async (chunk) => {
      sizes.push(chunk.length);
      q.take(chunk);
      return "continue";
    });
    expect(sizes).toEqual([5, 5, 2]);
    expect(q.asked).toEqual([5, 5, 5]);
    expect(r).toEqual({ attempted: 12, chunks: 3 });
    expect(s.sleeps).toEqual([1500, 1500]); // between chunks only, not after the last
    expect(q.left()).toBe(0);
  });

  it("stops at the limit, asking for no more than is left", async () => {
    const q = queue(100);
    const s = settings({ limit: 12 });
    const r = await processInChunks(q.load, s, async (chunk) => {
      q.take(chunk);
      return "continue";
    });
    expect(q.asked).toEqual([5, 5, 2]);
    expect(r.attempted).toBe(12);
    expect(q.left()).toBe(88);
    expect(s.sleeps).toHaveLength(2);
  });

  it("makes no call and no pause for an empty queue", async () => {
    const q = queue(0);
    const s = settings();
    const handle = vi.fn(async () => "continue" as const);
    expect(await processInChunks(q.load, s, handle)).toEqual({ attempted: 0, chunks: 0 });
    expect(handle).not.toHaveBeenCalled();
    expect(s.sleeps).toEqual([]);
  });

  it("stops when the handler says stop, without loading or pausing again", async () => {
    const q = queue(20);
    const s = settings();
    const r = await processInChunks(q.load, s, async () => "stop");
    expect(r.chunks).toBe(1);
    expect(q.asked).toEqual([5]);
    expect(s.sleeps).toEqual([]);
  });

  it("does not pause when the delay is 0", async () => {
    const q = queue(10);
    const s = settings({ delayMs: 0 });
    await processInChunks(q.load, s, async (c) => (q.take(c), "continue"));
    expect(s.sleeps).toEqual([]);
  });

  it("never hands out the same item twice in a run, so a stuck item cannot loop", async () => {
    const stuck = items(3); // never leaves the queue
    const handled: string[] = [];
    const r = await processInChunks(async (n) => stuck.slice(0, n), settings({ chunkSize: 3 }), async (chunk) => {
      handled.push(...chunk.map((c) => c.id));
      return "continue";
    });
    expect(handled).toEqual(["i0", "i1", "i2"]);
    expect(r.attempted).toBe(3);
  });

  it("does not start a chunk after the deadline", async () => {
    const q = queue(20);
    let t = 0;
    const s = settings({ deadlineAt: 100, now: () => t });
    const r = await processInChunks(q.load, s, async (c) => {
      q.take(c);
      t += 60; // each chunk takes 60ms
      return "continue";
    });
    expect(r.chunks).toBe(2);
    expect(q.left()).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const BASE_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  CRON_SECRET: "test-secret-0123456789",
};
const KEYS = ["BATCH_LIMIT", "MAX_ITEMS_PER_FEED", "STAGE_CHUNK_SIZE", "STAGE_DELAY_MS", "STAGE_TIME_BUDGET_MS"];

beforeEach(() => {
  Object.assign(process.env, BASE_ENV);
  for (const k of KEYS) delete process.env[k];
  resetEnvCache();
});

describe("volume settings", () => {
  it("default to a weekly-run sized batch", () => {
    expect(PIPELINE_DEFAULTS).toMatchObject({ BATCH_LIMIT: 25, MAX_ITEMS_PER_FEED: 15, STAGE_CHUNK_SIZE: 5, STAGE_DELAY_MS: 1500 });
    expect(env()).toMatchObject({ BATCH_LIMIT: 25, MAX_ITEMS_PER_FEED: 15, STAGE_CHUNK_SIZE: 5, STAGE_DELAY_MS: 1500 });
  });

  it("can be overridden by environment variables", () => {
    Object.assign(process.env, { BATCH_LIMIT: "40", MAX_ITEMS_PER_FEED: "8", STAGE_CHUNK_SIZE: "2", STAGE_DELAY_MS: "0" });
    resetEnvCache();
    expect(env()).toMatchObject({ BATCH_LIMIT: 40, MAX_ITEMS_PER_FEED: 8, STAGE_CHUNK_SIZE: 2, STAGE_DELAY_MS: 0 });
    expect(resolveChunkSettings()).toMatchObject({ limit: 40, chunkSize: 2, delayMs: 0 });
  });

  it.each([["BATCH_LIMIT", "0"], ["BATCH_LIMIT", "abc"], ["MAX_ITEMS_PER_FEED", "-1"], ["STAGE_CHUNK_SIZE", "0"], ["STAGE_DELAY_MS", "-5"]])(
    "rejects %s=%s",
    (key, value) => {
      process.env[key] = value;
      resetEnvCache();
      expect(() => env()).toThrow(/Invalid environment/);
    },
  );

  it("lets a call override the limit (the admin chunk) without touching the others", () => {
    expect(resolveChunkSettings({ limit: 5 })).toMatchObject({ limit: 5, chunkSize: 5, delayMs: 1500 });
  });
});

// ---------------------------------------------------------------------------
// Stages: chunking and rate limits
// ---------------------------------------------------------------------------
type Agent = <T>(p: CallAgentParams<T>) => Promise<CallAgentResult<T>>;
const rateLimited = { ok: false, reason: "rate_limited", error: "429" } as const;
/** Succeeds `okCalls` times with `data`, then reports a rate limit. */
function agentThat(okCalls: number, data: unknown): { agent: Agent; calls: () => number } {
  let n = 0;
  const agent = (async () => (++n <= okCalls ? { ok: true, data, attempts: 1 } : rateLimited)) as unknown as Agent;
  return { agent, calls: () => n };
}

const departments: Department[] = [{ id: "d-ev", name: "EV", description: "EVs", keywords: ["ev"], kind: "company" }];
const rawItems = (n: number): ClassifyItem[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, title: "EV news", content: "ev", kind: "company" }));

describe("runClassify in chunks", () => {
  function harness(n: number) {
    const q = rawItems(n);
    const updates: Record<string, { status: string }> = {};
    const asked: number[] = [];
    return {
      updates,
      asked,
      deps: {
        loadItems: async (want: number) => (asked.push(want), q.filter((i) => !updates[i.id]).slice(0, want)),
        loadDepartments: async () => departments,
        updateItem: async (id: string, u: { status: string }) => void (updates[id] = u),
      },
    };
  }
  const good = { department: "EV", relevance: 9, reason: "About EVs." };

  it("drains a queue bigger than a chunk, in order, pausing between chunks", async () => {
    const h = harness(12);
    const { agent } = agentThat(99, good);
    const sleeps: number[] = [];
    const counts = await runClassify({ ...h.deps, agent }, { sleep: async (ms) => void sleeps.push(ms) });
    expect(counts).toMatchObject({ processed: 12, relevant: 12, unprocessed: 0, stopped: null });
    expect(h.asked).toEqual([5, 5, 5]);
    expect(sleeps).toEqual([1500, 1500]);
  });

  it("stops at BATCH_LIMIT", async () => {
    process.env.BATCH_LIMIT = "7";
    resetEnvCache();
    const h = harness(30);
    const counts = await runClassify({ ...h.deps, agent: agentThat(99, good).agent }, { sleep: async () => {} });
    expect(counts.processed).toBe(7);
    expect(h.asked).toEqual([5, 2]);
  });

  it("on a rate limit stops cleanly: the rest stays unprocessed and nothing is marked failed", async () => {
    const h = harness(20);
    const { agent } = agentThat(7, good); // chunk 1 (5) fine, chunk 2: 2 fine then 429
    const counts = await runClassify({ ...h.deps, agent }, { sleep: async () => {} });
    expect(counts).toMatchObject({ processed: 7, failed: 0, stopped: "rate_limited", unprocessed: 3 });
    expect(Object.keys(h.updates)).toHaveLength(7);
    expect(Object.values(h.updates).every((u) => u.status !== "failed")).toBe(true);
    expect(h.asked).toEqual([5, 5]); // no third chunk
    // What the routes and `stage all` report:
    expect(progressOf("classify", counts as unknown as Record<string, unknown>, 13)).toMatchObject({ processed: 7, remaining: 13, rateLimited: true, failed: 0 });
  });

  it("stops with time_budget (not failed) when the deadline passes mid-chunk", async () => {
    const h = harness(10);
    let t = 0;
    const agent = (async () => ((t += 40), { ok: true, data: good, attempts: 1 })) as unknown as Agent;
    const counts = await runClassify({ ...h.deps, agent }, { deadlineAt: 100, now: () => t, sleep: async () => {} });
    expect(counts).toMatchObject({ processed: 3, failed: 0, stopped: "time_budget", unprocessed: 2 });
  });
});

describe("runWrite and runFactcheck leave rate-limited work queued", () => {
  it("write: unprocessed, never failed", async () => {
    const q: WriteItem[] = Array.from({ length: 12 }, (_, i) => ({
      id: `w${i}`, url: "https://e.com", title: "T", content: Array(200).fill("w").join(" "), full_text: null,
      source_published_at: null, department_id: "d", place: null, lat: null, lon: null,
    }));
    const updates: Record<string, unknown> = {};
    const goodArticle = { headline: "Headline here", body: Array(200).fill("w").join(" "), image_query: "q q", image_alt: "alt text" };
    const { agent } = agentThat(6, goodArticle);
    const counts = await runWrite(
      {
        loadItems: async (n) => q.filter((i) => !updates[i.id]).slice(0, n),
        insertArticle: async () => {},
        updateItem: async (id, u) => void (updates[id] = u),
        agent,
      },
      { sleep: async () => {} },
    );
    expect(counts).toMatchObject({ processed: 6, written: 6, failed: 0, stopped: "rate_limited", unprocessed: 4 });
    expect(Object.keys(updates)).toHaveLength(6);
  });

  it("factcheck: unprocessed, never rejected", async () => {
    const q: FactcheckArticle[] = Array.from({ length: 12 }, (_, i) => ({
      id: `f${i}`, raw_item_id: `r${i}`, headline: "H", body: "B",
      source: { title: "T", content: "source text", full_text: null, source_published_at: null },
    }));
    const updates: Record<string, { status: string }> = {};
    const { agent } = agentThat(5, { findings: [] });
    const counts = await runFactcheck(
      { loadArticles: async (n) => q.filter((a) => !updates[a.id]).slice(0, n), updateArticle: async (id, u) => void (updates[id] = u), agent },
      { sleep: async () => {} },
    );
    expect(counts).toMatchObject({ processed: 5, passed: 5, rejected: 0, stopped: "rate_limited", unprocessed: 5 });
    expect(Object.values(updates).every((u) => u.status === "pending_review")).toBe(true);
  });
});

describe("runImage in chunks", () => {
  const art = (id: string): ImageArticle => ({ id, image_query: "q", department_slug: "ev" });

  it("works through chunks and a 429 ends the run: that chunk takes defaults, later chunks stay queued", async () => {
    const q = Array.from({ length: 12 }, (_, i) => art(`a${i}`));
    const updates: Record<string, unknown> = {};
    const asked: number[] = [];
    const searchImage = vi.fn(async () => {
      if (searchImage.mock.calls.length > 6) throw new ImageSearchError("429", 429);
      return { url: "https://images.unsplash.com/x", credit: "c", creditUrl: "u" };
    });
    const report = { rateLimited: false };
    const counts = await runImage(
      {
        loadArticles: async (n) => (asked.push(n), q.filter((a) => !updates[a.id]).slice(0, n)),
        updateArticle: async (id, u) => void (updates[id] = u),
        provider: () => ({ searchImage }) as never,
      },
      { sleep: async () => {} },
      report,
    );
    expect(report.rateLimited).toBe(true);
    expect(counts).toEqual({ processed: 10, found: 6, fallback: 4, failed: 0, deferred: 0, blockImages: { placed: 0, dropped: 0 } });
    expect(asked).toEqual([5, 5]); // no third chunk
    expect(Object.keys(updates)).toHaveLength(10);
  });
});

describe("runStage: a provider stop is kept in pipeline_runs", () => {
  it("stores stoppedError in the error column of the run, which stays ok (no failure alert)", async () => {
    const saved: RunRecord[] = [];
    const error = "gemini gemini-3.8-flash, attempt 1 of 4: HTTP 504 DEADLINE_EXCEEDED: Deadline expired before operation could complete.";
    const summary = { processed: 0, remaining: 3, stopped: "provider_error", stoppedError: error };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await runStage("write", "cron", { run: async () => summary, save: async (r) => void saved.push(r) });
    log.mockRestore();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ stage: "write", ok: true, error, summary });
  });

  it("leaves the error column empty when the stage was not stopped by the provider", async () => {
    const saved: RunRecord[] = [];
    await runStage("write", "cron", { run: async () => ({ processed: 2, remaining: 0, stopped: null, stoppedError: null }), save: async (r) => void saved.push(r) });
    expect(saved[0]).toMatchObject({ ok: true, error: null });
  });
});

describe("progressOf", () => {
  it("passes the provider's error through", () => {
    expect(progressOf("write", { processed: 0, stopped: "provider_error", stoppedError: "HTTP 503 UNAVAILABLE: high demand" }, 3)).toMatchObject({
      stopped: "provider_error",
      stoppedError: "HTTP 503 UNAVAILABLE: high demand",
    });
  });

  it("maps each stage's own counts to processed / remaining / rejected", () => {
    expect(progressOf("factcheck", { processed: 5, passed: 3, rejected: 2, unprocessed: 0, stopped: null }, 4)).toEqual({
      processed: 5, remaining: 4, rateLimited: false, rejected: 2, failed: 0, stopped: null, stoppedError: null,
    });
    expect(progressOf("write", { processed: 4, written: 3, skipped: 1, failed: 0, unprocessed: 0, stopped: null }, 0)).toMatchObject({ rejected: 1, remaining: 0 });
    expect(progressOf("ingest", { totals: { inserted: 9, deferred: 6, tooOld: 3, failed: 1 } })).toEqual({
      processed: 9, remaining: 6, rateLimited: false, rejected: 3, failed: 1, stopped: null, stoppedError: null,
    });
  });

  it("falls back to the stage's own leftover count when the queue cannot be counted", () => {
    expect(progressOf("classify", { processed: 2, unprocessed: 3, stopped: "rate_limited" }, null)).toMatchObject({ remaining: 3, rateLimited: true });
  });

  it("reports an image rate limit", () => {
    expect(progressOf("image", { processed: 3, found: 0, fallback: 3, failed: 0, rateLimited: true }, 7)).toMatchObject({ rateLimited: true, remaining: 7 });
  });
});
