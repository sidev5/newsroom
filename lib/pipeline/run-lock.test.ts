import { beforeEach, describe, expect, it, vi } from "vitest";
import { STAGE_LOCK_STALE_MS } from "@/lib/config";
import {
  alertOnRepeatedFailure,
  failureStreak,
  isRepeatedFailure,
  shouldAlert,
  StageBusyError,
  STALE_RUN_NOTE,
  type AlertMail,
  type RecentRun,
  type RunRecord,
  type RunStore,
} from "./run-log";
import { runStage } from "./stages";

// BE-05 (one run of a stage at a time) and BE-06 (an alert after two failures in a row).

// ---------------------------------------------------------------------------
// A tiny in-memory pipeline_runs behind the real supabaseRunStore: same calls, same unique-index rule
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({ rows: [] as Row[], nextId: 1, insertError: null as { code: string; message: string } | null, failFinish: false }));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table !== "pipeline_runs") throw new Error(`unexpected table ${table}`);
      const filters: ((r: Row) => boolean)[] = [];
      let op: "select" | "insert" | "update" = "select";
      let payload: Row = {};
      let single = false;
      let order: { col: string; asc: boolean } | null = null;
      let max = Infinity;
      const b = {
        insert(p: Row) { op = "insert"; payload = p; return b; },
        update(p: Row) { op = "update"; payload = p; return b; },
        select() { return b; },
        eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b; },
        is(c: string, v: null) { filters.push((r) => (r[c] ?? null) === v); return b; },
        lt(c: string, v: string) { filters.push((r) => String(r[c]) < v); return b; },
        not(c: string, _op: string, v: null) { filters.push((r) => (r[c] ?? null) !== v); return b; },
        order(col: string, o: { ascending: boolean }) { order = { col, asc: o.ascending }; return b; },
        limit(n: number) { max = n; return b; },
        single() { single = true; return b; },
        then(resolve: (v: unknown) => void) {
          resolve(run());
        },
      };
      function run() {
        if (op === "insert") {
          if (db.insertError) return { data: null, error: db.insertError };
          if (payload.finished_at == null && db.rows.some((r) => r.stage === payload.stage && r.finished_at == null)) {
            return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
          }
          const row = { id: `run-${db.nextId++}`, alert_sent: false, ...payload };
          db.rows.push(row);
          return { data: single ? row : [row], error: null };
        }
        const hit = db.rows.filter((r) => filters.every((f) => f(r)));
        if (op === "update") {
          if (db.failFinish && payload.finished_at && payload.ok !== false) return { data: null, error: { code: "XX000", message: "db down" } };
          for (const r of hit) Object.assign(r, payload);
          return { data: hit, error: null };
        }
        const sorted = order ? [...hit].sort((x, y) => (order!.asc ? 1 : -1) * String(x[order!.col]).localeCompare(String(y[order!.col]))) : hit;
        return { data: sorted.slice(0, max), error: null };
      }
      return b;
    },
  }),
}));

import { supabaseRunStore } from "./run-store";

const T0 = new Date("2026-10-16T05:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

beforeEach(() => {
  db.rows = [];
  db.nextId = 1;
  db.insertError = null;
  db.failFinish = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the stage lock (pipeline_runs with no finished_at)", () => {
  it("lets a stage run and records a running row first", async () => {
    const store = supabaseRunStore();
    const got = await store.acquire("write", "cron", T0, STAGE_LOCK_STALE_MS);
    expect(got).toMatchObject({ ok: true, handle: { id: "run-1" } });
    expect(db.rows).toEqual([expect.objectContaining({ stage: "write", finished_at: null, ok: null, triggered_by: "cron" })]);
  });

  it("refuses the same stage while it is running, and says who started it", async () => {
    const store = supabaseRunStore();
    await store.acquire("write", "cron", T0, STAGE_LOCK_STALE_MS);
    const second = await store.acquire("write", "editor@example.com", at(1), STAGE_LOCK_STALE_MS);
    expect(second).toEqual({ ok: false, startedAt: T0.toISOString(), triggeredBy: "cron" });
    expect(db.rows).toHaveLength(1);
  });

  it("does not block a different stage", async () => {
    const store = supabaseRunStore();
    await store.acquire("write", "cron", T0, STAGE_LOCK_STALE_MS);
    expect(await store.acquire("classify", "cron", at(1), STAGE_LOCK_STALE_MS)).toMatchObject({ ok: true });
  });

  it("is released when the run finishes, and the row becomes the run's record", async () => {
    const store = supabaseRunStore();
    const got = await store.acquire("write", "cron", T0, STAGE_LOCK_STALE_MS);
    if (!got.ok) throw new Error("expected the lock");
    const record: RunRecord = { stage: "write", started_at: T0.toISOString(), finished_at: at(2).toISOString(), ok: true, summary: { processed: 3 }, error: null, triggered_by: "cron" };
    await store.finish(got.handle, record);
    expect(db.rows).toHaveLength(1); // updated in place, not a second row
    expect(db.rows[0]).toMatchObject({ finished_at: at(2).toISOString(), ok: true, summary: { processed: 3 } });
    expect(await store.acquire("write", "cron", at(3), STAGE_LOCK_STALE_MS)).toMatchObject({ ok: true });
  });

  it("a run that never finished stops blocking after 10 minutes, and is recorded as failed", async () => {
    const store = supabaseRunStore();
    await store.acquire("write", "cron", T0, STAGE_LOCK_STALE_MS);
    expect(STAGE_LOCK_STALE_MS).toBe(10 * 60_000);

    // 9 minutes later it still holds the stage...
    expect(await store.acquire("write", "cron", at(9), STAGE_LOCK_STALE_MS)).toMatchObject({ ok: false });
    // ...and 11 minutes later it does not.
    const later = await store.acquire("write", "editor@example.com", at(11), STAGE_LOCK_STALE_MS);
    expect(later).toMatchObject({ ok: true });
    expect(db.rows).toHaveLength(2);
    expect(db.rows[0]).toMatchObject({ ok: false, error: STALE_RUN_NOTE, finished_at: at(11).toISOString() });
    expect(db.rows[1]).toMatchObject({ finished_at: null, triggered_by: "editor@example.com" });
  });

  it("runs unlocked (and does not fail the stage) when the table cannot be used: the migration is not applied yet", async () => {
    db.insertError = { code: "23502", message: 'null value in column "finished_at" violates not-null constraint' };
    const store = supabaseRunStore();
    expect(await store.acquire("write", "cron", T0, STAGE_LOCK_STALE_MS)).toEqual({ ok: true, handle: { id: null } });
    // the outcome is then stored as a whole row, as before the lock existed
    db.insertError = null;
    const id = await store.finish({ id: null }, { stage: "write", started_at: T0.toISOString(), finished_at: at(1).toISOString(), ok: true, summary: {}, error: null, triggered_by: "cron" });
    expect(id).toBe("run-1");
    expect(db.rows[0]).toMatchObject({ stage: "write", ok: true });
  });

  it("recent() lists finished runs only, newest first", async () => {
    const store = supabaseRunStore();
    for (const [i, ok] of [true, false, false].entries()) {
      const got = await store.acquire("write", "cron", at(i * 20), STAGE_LOCK_STALE_MS);
      if (!got.ok) throw new Error("lock");
      await store.finish(got.handle, { stage: "write", started_at: at(i * 20).toISOString(), finished_at: at(i * 20 + 1).toISOString(), ok, summary: null, error: ok ? null : `boom ${i}`, triggered_by: "cron" });
    }
    await store.acquire("write", "cron", at(100), STAGE_LOCK_STALE_MS); // still running: not listed
    const runs = await store.recent("write", 10);
    expect(runs.map((r) => [r.ok, r.error])).toEqual([[false, "boom 2"], [false, "boom 1"], [true, null]]);
  });
});

describe("runStage and the lock", () => {
  it("a second call while the first is running throws StageBusyError and runs nothing", async () => {
    const store = supabaseRunStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = vi.fn(async () => {
      await gate;
      return { processed: 1 };
    });
    const first = runStage("classify", "cron", { store, run: slow, alertMail: () => null });
    await vi.waitFor(() => expect(db.rows).toHaveLength(1)); // the first one holds the lock

    const cronAgain = vi.fn(async () => ({ processed: 99 }));
    await expect(runStage("classify", "editor@example.com", { store, run: cronAgain, alertMail: () => null })).rejects.toBeInstanceOf(StageBusyError);
    expect(cronAgain).not.toHaveBeenCalled();
    expect(db.rows).toHaveLength(1); // a refused run leaves no row

    release();
    await expect(first).resolves.toEqual({ processed: 1 });
    expect(db.rows[0]).toMatchObject({ ok: true, summary: { processed: 1 }, triggered_by: "cron" });
    // now it can run again
    await expect(runStage("classify", "cron", { store, run: async () => ({ processed: 2 }), alertMail: () => null })).resolves.toEqual({ processed: 2 });
  });

  it("the error says which stage, since when and who", async () => {
    const store = supabaseRunStore();
    await store.acquire("image", "cron", T0, STAGE_LOCK_STALE_MS);
    const err = (await runStage("image", "editor@example.com", { store, run: async () => ({}), now: () => at(1), alertMail: () => null }).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(StageBusyError);
    expect(err.message).toBe("image is already running (started 2026-10-16 05:00 UTC by cron). Try again when it has finished.");
  });

  it("the lock is released when the stage throws, and the failure is recorded", async () => {
    const store = supabaseRunStore();
    await expect(runStage("write", "cron", { store, run: async () => Promise.reject(new Error("provider down")), alertMail: () => null })).rejects.toThrow("provider down");
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ ok: false, error: "provider down" });
    expect(db.rows[0].finished_at).not.toBeNull();
    await expect(runStage("write", "cron", { store, run: async () => ({}), alertMail: () => null })).resolves.toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Failures in a row
// ---------------------------------------------------------------------------
const run = (ok: boolean, over: Partial<RecentRun> = {}): RecentRun => ({ id: `r${Math.random()}`, ok, error: ok ? null : "boom", finished_at: T0.toISOString(), alert_sent: false, ...over });

describe("failureStreak", () => {
  it("counts the failures since the last success", () => {
    expect(failureStreak("write", []).count).toBe(0);
    expect(failureStreak("write", [run(true), run(false)]).count).toBe(0);
    expect(failureStreak("write", [run(false), run(true), run(false)]).count).toBe(1);
    expect(failureStreak("write", [run(false), run(false), run(true), run(false)]).count).toBe(2);
    expect(failureStreak("write", [run(false), run(false), run(false)]).count).toBe(3);
  });

  it("reports the latest error and whether an alert already went out for this streak", () => {
    const s = failureStreak("write", [run(false, { error: "newest" }), run(false, { alert_sent: true }), run(true, { alert_sent: true })]);
    expect(s).toMatchObject({ stage: "write", count: 2, lastError: "newest", alerted: true });
    // an alert from before the last success belongs to an older streak
    expect(failureStreak("write", [run(false), run(false), run(true), run(false, { alert_sent: true })]).alerted).toBe(false);
  });

  it("two in a row is a repeated failure; one alert per streak", () => {
    expect(isRepeatedFailure(failureStreak("write", [run(false)]))).toBe(false);
    expect(isRepeatedFailure(failureStreak("write", [run(false), run(false)]))).toBe(true);
    expect(shouldAlert(failureStreak("write", [run(false), run(false)]))).toBe(true);
    expect(shouldAlert(failureStreak("write", [run(false), run(false, { alert_sent: true })]))).toBe(false);
  });
});

describe("alertOnRepeatedFailure", () => {
  const link = "https://news.example.com/admin/review?tab=pipeline";

  function setup(runs: RecentRun[]) {
    const marked: string[] = [];
    const store = { recent: async () => runs, markAlerted: async (id: string) => void marked.push(id) };
    const sent: { subject: string; text: string }[] = [];
    const mail: AlertMail = { send: async (subject, text) => void sent.push({ subject, text }) };
    return { store, mail, sent, marked };
  }

  it("does nothing after a single failure", async () => {
    const t = setup([run(false)]);
    expect(await alertOnRepeatedFailure("write", { ...t, link })).toBe("not_needed");
    expect(t.sent).toEqual([]);
  });

  it("sends ONE email on the second failure in a row, and marks the run", async () => {
    const t = setup([run(false, { id: "newest", error: "Provider quota exceeded" }), run(false)]);
    expect(await alertOnRepeatedFailure("write", { ...t, link })).toBe("sent");
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].subject).toBe("Company Newsroom: write failed 2 times in a row");
    expect(t.sent[0].text).toContain("Provider quota exceeded");
    expect(t.sent[0].text).toContain(link);
    expect(t.marked).toEqual(["newest"]);
  });

  it("sends nothing more on the third failure, while the streak is the same", async () => {
    const t = setup([run(false), run(false), run(false, { alert_sent: true })]);
    expect(await alertOnRepeatedFailure("write", { ...t, link })).toBe("not_needed");
    expect(t.sent).toEqual([]);
  });

  it("alerts again for a new streak after a success", async () => {
    const t = setup([run(false), run(false), run(true), run(false, { alert_sent: true }), run(false, { alert_sent: true })]);
    expect(await alertOnRepeatedFailure("write", { ...t, link })).toBe("sent");
  });

  it("without email configured the banner is all there is: no error, and nothing marked", async () => {
    const t = setup([run(false), run(false)]);
    expect(await alertOnRepeatedFailure("write", { store: t.store, mail: null, link })).toBe("no_mail");
    expect(t.marked).toEqual([]);
  });

  it("a send that fails is not marked, so the next failure tries again, and it never throws", async () => {
    const t = setup([run(false), run(false)]);
    const log = vi.fn();
    const broken: AlertMail = { send: async () => Promise.reject(new Error("SMTP down")) };
    expect(await alertOnRepeatedFailure("write", { store: t.store, mail: broken, link, log })).toBe("send_failed");
    expect(t.marked).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("SMTP down"));
  });

  it("a store that fails does not throw either", async () => {
    const log = vi.fn();
    const store = { recent: async () => Promise.reject(new Error("db down")), markAlerted: async () => {} };
    expect(await alertOnRepeatedFailure("write", { store, mail: null, link, log })).toBe("send_failed");
  });
});

describe("runStage sends the alert when a run fails", () => {
  function memoryStore() {
    const finished: RecentRun[] = [];
    const marked: string[] = [];
    const store: RunStore = {
      acquire: async () => ({ ok: true, handle: { id: null } }),
      finish: async (_h, r) => {
        const id = `run-${finished.length + 1}`;
        finished.unshift({ id, ok: r.ok, error: r.error, finished_at: r.finished_at, alert_sent: false });
        return id;
      },
      recent: async () => finished,
      markAlerted: async (id) => {
        marked.push(id);
        const row = finished.find((f) => f.id === id);
        if (row) row.alert_sent = true;
      },
    };
    return { store, marked };
  }

  it("emails once for failure #2, stays quiet for #3, and starts over after a success", async () => {
    const { store } = memoryStore();
    const send = vi.fn(async () => {});
    const alertMail = () => ({ send });
    const fail = () => runStage("factcheck", "cron", { store, run: async () => Promise.reject(new Error("quota")), alertMail }).catch(() => {});
    const succeed = () => runStage("factcheck", "cron", { store, run: async () => ({}), alertMail });

    await fail();
    expect(send).toHaveBeenCalledTimes(0);
    await fail();
    expect(send).toHaveBeenCalledTimes(1);
    await fail();
    expect(send).toHaveBeenCalledTimes(1);
    await succeed();
    await fail();
    expect(send).toHaveBeenCalledTimes(1);
    await fail();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("a successful run never sends an alert, and a missing mail setup does not break the failing run", async () => {
    const { store } = memoryStore();
    const send = vi.fn(async () => {});
    await runStage("write", "cron", { store, run: async () => ({}), alertMail: () => ({ send }) });
    expect(send).not.toHaveBeenCalled();
    await expect(runStage("write", "cron", { store, run: async () => Promise.reject(new Error("a")), alertMail: () => null })).rejects.toThrow("a");
    await expect(runStage("write", "cron", { store, run: async () => Promise.reject(new Error("b")), alertMail: () => null })).rejects.toThrow("b");
  });
});
