import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeSupabase } from "../../test/fake-supabase";

// runIngest end to end: the real stage runner (lock, run record), the real fetcher (SSRF guard, redirects, robots.txt, size cap),
// the real parser, extractor and deduplication, and the real Supabase calls, against fake feeds and an in-memory database.
// Only the network (fetch and DNS) and the database are replaced.

const world = vi.hoisted(() => ({
  db: null as unknown,
  /** host -> address its name resolves to; anything else resolves to a public address */
  dns: {} as Record<string, string>,
}));

vi.mock("node:dns/promises", () => ({ lookup: async (host: string) => [{ address: world.dns[host] ?? "93.184.216.34", family: 4 }] }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => (world.db as FakeSupabase).client }));

import { resetEnvCache } from "@/lib/env";
import { StageBusyError } from "./run-log";
import { runStage } from "./stages";

const PAGE = `<html><head><title>Story</title></head><body><article><h1>Pilot line</h1>${Array.from(
  { length: 6 },
  (_, i) => `<p>Paragraph ${i + 1}: the company said the pilot line reached its first production milestone this quarter, with output rising steadily while unit costs fell against the earlier plan, and suppliers in the region are expanding capacity.</p>`,
).join("")}</article></body></html>`;

const rss = (site: string, items: number) => {
  const when = new Date(Date.now() - 60_000).toUTCString();
  const entries = Array.from(
    { length: items },
    (_, i) => `<item><title>${site} story ${i}</title><link>https://${site}.example.com/story-${i}</link><description>Summary of ${site} story ${i}</description><pubDate>${when}</pubDate></item>`,
  ).join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>${site}</title>${entries}</channel></rss>`;
};

const requested: { url: string; redirect?: string }[] = [];
let gate: Promise<void> | null = null;

const site = {
  "https://feed1.example.com/rss": () => new Response(rss("site1", 3), { status: 200 }),
  "https://feed2.example.com/rss": () => new Response(rss("site2", 2), { status: 200 }),
  "https://redirect-feed.example.com/rss": () => new Response(null, { status: 301, headers: { location: "http://169.254.169.254/latest/meta-data/" } }),
  "https://site1.example.com/robots.txt": () => new Response("Not found", { status: 404 }),
  "https://site2.example.com/robots.txt": () => new Response("User-agent: *\nDisallow: /\n", { status: 200 }),
  "https://site1.example.com/story-0": () => new Response(PAGE, { status: 200 }),
  "https://site1.example.com/story-1": () => new Response(null, { status: 302, headers: { location: "http://localhost/admin" } }),
  "https://site1.example.com/story-2": () => new Response("Server error", { status: 500 }),
} as Record<string, () => Response>;

const fetchStub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  requested.push({ url: u, redirect: init?.redirect });
  if (gate) await gate;
  return (site[u]?.() ?? new Response("Not found", { status: 404 })) as Response;
});

let fake: FakeSupabase;

const source = (n: number, url: string, active = true) => ({ id: `s${n}`, name: `Source ${n}`, rss_url: url, department_id: "d1", active });

function database(sources: ReturnType<typeof source>[]) {
  fake = createFakeSupabase(
    { sources, raw_items: [], pipeline_runs: [] },
    {
      uniques: {
        // the partial unique index of 2026-10-19_reliability.sql: one run in progress per stage
        pipeline_runs: (row, rows) => row.finished_at == null && rows.some((r) => r.stage === row.stage && r.finished_at == null),
      },
    },
  );
  world.db = fake;
}

beforeEach(() => {
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    CRON_SECRET: "test-secret-0123456789abcdef",
    MAX_ITEMS_PER_FEED: "15",
    FETCH_TIMEOUT_MS: "10000",
  });
  delete process.env.STAGE_TIME_BUDGET_MS;
  resetEnvCache();
  world.dns = {};
  requested.length = 0;
  gate = null;
  fetchStub.mockClear();
  vi.stubGlobal("fetch", fetchStub);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const items = () => fake.tables.raw_items;
const summaryOf = (s: unknown) => s as { processed: number; remaining: number; rejected: number; failed: number; stopped: string | null; totals: Record<string, number>; sources: { source: string; error?: string }[] };

describe("ingest from fake feeds, end to end", () => {
  it("reads two feeds, stores every item, fetches the pages that robots.txt allows, and records the run", async () => {
    database([source(1, "https://feed1.example.com/rss"), source(2, "https://feed2.example.com/rss")]);
    const s = summaryOf(await runStage("ingest", "cron"));

    expect(s.totals).toMatchObject({ fetched: 5, inserted: 5, duplicates: 0, failed: 0, deferred: 0, sourcesDeferred: 0 });
    expect(s).toMatchObject({ processed: 5, stopped: null });
    expect(items().map((r) => r.url).sort()).toEqual([
      "https://site1.example.com/story-0", "https://site1.example.com/story-1", "https://site1.example.com/story-2",
      "https://site2.example.com/story-0", "https://site2.example.com/story-1",
    ]);

    const byUrl = Object.fromEntries(items().map((r) => [r.url as string, r]));
    // an allowed page: its main text is stored as full_text
    expect(String(byUrl["https://site1.example.com/story-0"].full_text)).toContain("pilot line reached its first production milestone");
    // a page that errors, or redirects somewhere forbidden: the item is still stored, from the feed's own summary
    expect(byUrl["https://site1.example.com/story-1"].full_text).toBeNull();
    expect(byUrl["https://site1.example.com/story-2"].full_text).toBeNull();
    expect(byUrl["https://site1.example.com/story-1"].content).toBe("Summary of site1 story 1");
    // robots.txt disallows site2: its pages were never requested
    expect(byUrl["https://site2.example.com/story-0"].full_text).toBeNull();
    expect(requested.some((r) => r.url.startsWith("https://site2.example.com/story-"))).toBe(false);
    // every row carries its source and department
    expect(items().every((r) => r.source_id && r.department_id === "d1")).toBe(true);

    // the run is recorded: finished, ok, with the summary
    expect(fake.tables.pipeline_runs).toHaveLength(1);
    expect(fake.tables.pipeline_runs[0]).toMatchObject({ stage: "ingest", ok: true, error: null, triggered_by: "cron" });
    expect(fake.tables.pipeline_runs[0].finished_at).not.toBeNull();
    expect((fake.tables.pipeline_runs[0].summary as { totals: { inserted: number } }).totals.inserted).toBe(5);
  });

  it("never lets fetch follow a redirect by itself, and never requests the forbidden address a page redirected to", async () => {
    database([source(1, "https://feed1.example.com/rss")]);
    await runStage("ingest", "cron");
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.every((r) => r.redirect === "manual")).toBe(true);
    expect(requested.some((r) => /localhost|169\.254|127\.0\.0\.1/.test(r.url))).toBe(false);
  });

  it("a second run finds everything already stored: nothing is inserted twice", async () => {
    database([source(1, "https://feed1.example.com/rss"), source(2, "https://feed2.example.com/rss")]);
    await runStage("ingest", "cron");
    const second = summaryOf(await runStage("ingest", "cron"));
    expect(second.totals).toMatchObject({ fetched: 5, inserted: 0, duplicates: 5, failed: 0 });
    expect(items()).toHaveLength(5);
    expect(fake.tables.pipeline_runs).toHaveLength(2);
    expect(fake.tables.pipeline_runs.every((r) => r.ok === true)).toBe(true);
  });

  it("skips inactive sources", async () => {
    database([source(1, "https://feed1.example.com/rss"), source(2, "https://feed2.example.com/rss", false)]);
    const s = summaryOf(await runStage("ingest", "cron"));
    expect(s.totals.fetched).toBe(3);
    expect(requested.some((r) => r.url.includes("feed2"))).toBe(false);
  });

  it("caps the new items per feed (MAX_ITEMS_PER_FEED) and reports the rest as deferred for the next run", async () => {
    process.env.MAX_ITEMS_PER_FEED = "2";
    resetEnvCache();
    database([source(1, "https://feed1.example.com/rss")]);
    const first = summaryOf(await runStage("ingest", "cron"));
    expect(first.totals).toMatchObject({ inserted: 2, deferred: 1 });
    expect(first.remaining).toBe(1);
    const second = summaryOf(await runStage("ingest", "cron"));
    expect(second.totals).toMatchObject({ inserted: 1, duplicates: 2 });
    expect(items()).toHaveLength(3);
  });

  it("a feed that fails (HTTP 404) is counted and does not stop the others", async () => {
    database([source(1, "https://gone.example.com/rss"), source(2, "https://feed2.example.com/rss")]);
    const s = summaryOf(await runStage("ingest", "cron"));
    expect(s.totals).toMatchObject({ failed: 1, inserted: 2 });
    expect(s.sources[0].error).toMatch(/feed: HTTP 404/);
    expect(fake.tables.pipeline_runs[0].ok).toBe(true); // a bad feed is a count, not a failed run
  });
});

describe("hostile feeds (SEC-07), end to end", () => {
  it("a feed whose host name resolves to a private address is refused before any request", async () => {
    world.dns["attacker-feed.example.net"] = "10.0.0.9";
    database([source(1, "https://attacker-feed.example.net/rss"), source(2, "https://feed2.example.com/rss")]);
    const s = summaryOf(await runStage("ingest", "cron"));
    expect(s.totals).toMatchObject({ failed: 1, inserted: 2 });
    expect(s.sources[0].error).toMatch(/resolves to a private or reserved address \(10\.0\.0\.9\)/);
    expect(requested.some((r) => r.url.includes("attacker-feed"))).toBe(false);
  });

  it.each(["http://127.0.0.1/rss", "http://10.1.2.3/rss", "http://169.254.169.254/latest/meta-data/", "http://[::1]/rss", "http://localhost/rss", "https://feed.example.com:8443/rss", "file:///etc/passwd"])(
    "a feed at %s is refused before any request",
    async (url) => {
      database([source(1, url)]);
      const s = summaryOf(await runStage("ingest", "cron"));
      expect(s.totals).toMatchObject({ failed: 1, inserted: 0 });
      expect(requested).toEqual([]);
      expect(items()).toEqual([]);
    },
  );

  it("a feed that redirects to the cloud metadata address is stopped after its first request", async () => {
    database([source(1, "https://redirect-feed.example.com/rss")]);
    const s = summaryOf(await runStage("ingest", "cron"));
    expect(s.totals).toMatchObject({ failed: 1, inserted: 0 });
    expect(requested.map((r) => r.url)).toEqual(["https://redirect-feed.example.com/rss"]);
    expect(requested.some((r) => r.url.includes("169.254"))).toBe(false);
  });
});

describe("the lock and the time budget, end to end", () => {
  it("two ingest runs at once: the second is refused and nothing is fetched twice; after the first the stage can run again", async () => {
    database([source(1, "https://feed2.example.com/rss")]);
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    const first = runStage("ingest", "cron");
    await vi.waitFor(() => expect(fake.tables.pipeline_runs).toHaveLength(1)); // the first holds the lock
    expect(fake.tables.pipeline_runs[0].finished_at ?? null).toBeNull();

    await expect(runStage("ingest", "editor@example.com")).rejects.toBeInstanceOf(StageBusyError);
    expect(fake.tables.pipeline_runs).toHaveLength(1);

    release();
    gate = null;
    await first;
    expect(fake.tables.pipeline_runs[0].finished_at).not.toBeNull();
    expect(items()).toHaveLength(2); // stored once, by the first run
    await expect(runStage("ingest", "cron")).resolves.toBeDefined();
  });

  it("a deadline that has already passed: no feed is read, everything is deferred, and the run is still recorded", async () => {
    database([source(1, "https://feed1.example.com/rss"), source(2, "https://feed2.example.com/rss")]);
    const s = summaryOf(await runStage("ingest", "cron", { options: { deadlineAt: Date.now() - 1 } }));
    expect(requested).toEqual([]);
    expect(s.totals).toMatchObject({ inserted: 0, sourcesDeferred: 2 });
    expect(s.stopped).toBe("time_budget");
    expect(fake.tables.pipeline_runs).toHaveLength(1);
    expect(fake.tables.pipeline_runs[0]).toMatchObject({ ok: true, error: null });
    expect((fake.tables.pipeline_runs[0].summary as { stopped: string }).stopped).toBe("time_budget");
  });

  it("a stage that throws is recorded as failed and releases the lock", async () => {
    database([source(1, "https://feed1.example.com/rss")]);
    const from = fake.client.from;
    fake.client.from = ((table: string) => {
      if (table === "sources") throw new Error("database unreachable");
      return from(table);
    }) as typeof from; // loading the sources will fail
    await expect(runStage("ingest", "cron")).rejects.toBeDefined();
    expect(fake.tables.pipeline_runs[0]).toMatchObject({ ok: false });
    expect(fake.tables.pipeline_runs[0].finished_at).not.toBeNull();
  });
});
