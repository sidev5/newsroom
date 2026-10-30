import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { formatTrim, parseTrimArgs, planTrim, rankQueue, runTrimQueue, TRIM_REASON, TrimRefused, type QueueRow, type TrimStore } from "./trim-queue";

const row = (id: string, score: number | null, day: number): QueueRow => ({ id, relevance_score: score, fetched_at: `2026-10-${String(day).padStart(2, "0")}T10:00:00.000Z` });

describe("the command line", () => {
  const parse = (...a: string[]) => parseTrimArgs(["node", "run-stage", "trim-queue", ...a]);

  it("is a dry run with 30 by default", () => {
    expect(parse()).toEqual({ ok: true, keep: 30, apply: false });
  });
  it("reads --keep N, --keep=N and --apply, in any order", () => {
    expect(parse("--keep", "30")).toEqual({ ok: true, keep: 30, apply: false });
    expect(parse("--apply", "--keep=12")).toEqual({ ok: true, keep: 12, apply: true });
    expect(parse("--keep", "5", "--apply")).toEqual({ ok: true, keep: 5, apply: true });
  });
  it.each([["--keep"], ["--keep", "x"], ["--keep", "-3"], ["--keep", "2.5"], ["--keep", "0"], ["--keep", "999999"], ["--kepp", "30"], ["--apply=yes"], ["30"]])("refuses %j", (...a) => {
    const r = parse(...a);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Usage: npm run stage -- trim-queue/);
  });
});

describe("which items are kept", () => {
  it("highest relevance_score first, then newest", () => {
    const rows = [row("old9", 9, 1), row("new7", 7, 9), row("new9", 9, 8), row("mid8", 8, 5), row("old7", 7, 2)];
    expect(rankQueue(rows).map((r) => r.id)).toEqual(["new9", "old9", "mid8", "new7", "old7"]);
  });

  it("an item with no score comes last, newest first among those", () => {
    const rows = [row("none-old", null, 1), row("low", 1, 1), row("none-new", null, 9)];
    expect(rankQueue(rows).map((r) => r.id)).toEqual(["low", "none-new", "none-old"]);
  });

  it("is the same for the same queue however it arrives, and does not change its input", () => {
    const rows = [row("b", 5, 3), row("a", 5, 3), row("c", 5, 3)];
    const copy = [...rows];
    expect(rankQueue(rows).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(rankQueue([...rows].reverse()).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(rows).toEqual(copy);
  });

  it("keeps the first N and trims the rest; keeps everything when the queue is short", () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(`i${i}`, i % 10, (i % 28) + 1));
    const plan = planTrim(rows, 30);
    expect(plan.keep).toHaveLength(30);
    expect(plan.trim).toHaveLength(20);
    // everything kept is at least as good as everything trimmed
    expect(Math.min(...plan.keep.map((r) => r.relevance_score!))).toBeGreaterThanOrEqual(Math.max(...plan.trim.map((r) => r.relevance_score!)));
    expect(planTrim(rows.slice(0, 10), 30)).toEqual({ keep: rankQueue(rows.slice(0, 10)), trim: [] });
    expect(planTrim([], 30)).toEqual({ keep: [], trim: [] });
  });
});

function fakeStore(rows: QueueRow[], over: { running?: string[]; skippedAlready?: number; leaveBetween?: Set<string> } = {}) {
  const status = new Map(rows.map((r) => [r.id, "new-relevant"]));
  let skippedAlready = over.skippedAlready ?? 0;
  const calls: { ids: string[]; reason: string }[] = [];
  const store: TrimStore = {
    queue: async () => rows.filter((r) => status.get(r.id) === "new-relevant"),
    counts: async () => ({ newRelevant: [...status.values()].filter((s) => s === "new-relevant").length, skipped: skippedAlready + [...status.values()].filter((s) => s === "skipped").length }),
    runningStages: async () => over.running ?? [],
    skip: vi.fn(async (ids: string[], reason: string) => {
      calls.push({ ids, reason });
      let changed = 0;
      for (const id of ids) {
        if (status.get(id) === "new-relevant" && !over.leaveBetween?.has(id)) {
          status.set(id, "skipped");
          changed++;
        }
      }
      return changed;
    }),
  };
  return { store, calls, status, setSkipped: (n: number) => (skippedAlready = n) };
}

const queue = (n: number) => Array.from({ length: n }, (_, i) => row(`i${String(i).padStart(3, "0")}`, i % 11, (i % 28) + 1));

describe("runTrimQueue", () => {
  it("a dry run changes nothing, and says what the counts would be", async () => {
    const t = fakeStore(queue(212), { skippedAlready: 340 });
    const r = await runTrimQueue(t.store, { keep: 30, apply: false });
    expect(t.store.skip).not.toHaveBeenCalled();
    expect(r).toMatchObject({ apply: false, before: { newRelevant: 212, skipped: 340 }, after: { newRelevant: 30, skipped: 522 }, kept: 30, planned: 182, trimmed: 0 });
    expect([...t.status.values()].every((s) => s === "new-relevant")).toBe(true);
  });

  it("with --apply skips exactly the ones that are not kept, with the reason, in batches of 100, and reads the counts again", async () => {
    const t = fakeStore(queue(212), { skippedAlready: 340 });
    const plan = planTrim(queue(212), 30);
    const r = await runTrimQueue(t.store, { keep: 30, apply: true });
    expect(t.calls.map((c) => c.ids.length)).toEqual([100, 82]);
    expect(new Set(t.calls.map((c) => c.reason))).toEqual(new Set([TRIM_REASON]));
    expect(TRIM_REASON).toBe("trimmed_backlog");
    expect(new Set(t.calls.flatMap((c) => c.ids))).toEqual(new Set(plan.trim.map((x) => x.id)));
    expect(r).toMatchObject({ apply: true, trimmed: 182, after: { newRelevant: 30, skipped: 522 } });
    // what is left in the queue is the kept set
    expect(new Set([...t.status].filter(([, s]) => s === "new-relevant").map(([id]) => id))).toEqual(new Set(plan.keep.map((x) => x.id)));
  });

  it("running it again changes nothing more", async () => {
    const t = fakeStore(queue(60));
    await runTrimQueue(t.store, { keep: 30, apply: true });
    const again = await runTrimQueue(t.store, { keep: 30, apply: true });
    expect(again).toMatchObject({ planned: 0, trimmed: 0, before: { newRelevant: 30 }, after: { newRelevant: 30 } });
  });

  it("a queue that is not longer than N is left alone", async () => {
    const t = fakeStore(queue(20));
    const r = await runTrimQueue(t.store, { keep: 30, apply: true });
    expect(t.store.skip).not.toHaveBeenCalled();
    expect(r).toMatchObject({ kept: 20, planned: 0, after: { newRelevant: 20 } });
  });

  it("items that left the queue while it ran are not counted as trimmed", async () => {
    const plan = planTrim(queue(40), 30);
    const gone = new Set(plan.trim.slice(0, 3).map((x) => x.id));
    const t = fakeStore(queue(40), { leaveBetween: gone });
    const r = await runTrimQueue(t.store, { keep: 30, apply: true });
    expect(r).toMatchObject({ planned: 10, trimmed: 7 });
    expect(formatTrim(r)).toMatch(/3 of the 10 chosen had already left the queue/);
  });

  it("refuses to apply while the write or classify stage is running, and changes nothing; a dry run is still allowed", async () => {
    const t = fakeStore(queue(60), { running: ["write"] });
    await expect(runTrimQueue(t.store, { keep: 30, apply: true })).rejects.toThrow(TrimRefused);
    await expect(runTrimQueue(t.store, { keep: 30, apply: true })).rejects.toThrow(/write stage is running/);
    expect(t.store.skip).not.toHaveBeenCalled();
    await expect(runTrimQueue(t.store, { keep: 30, apply: false })).resolves.toMatchObject({ planned: 30 });
    // another stage running does not matter
    await expect(runTrimQueue(fakeStore(queue(60), { running: ["image"] }).store, { keep: 30, apply: true })).resolves.toMatchObject({ trimmed: 30 });
  });

  it("reports the scores of what was kept and what was trimmed", async () => {
    const t = fakeStore([row("a", 9, 1), row("b", 8, 2), row("c", 3, 3), row("d", null, 4)]);
    const r = await runTrimQueue(t.store, { keep: 2, apply: false });
    expect(r.keptScores).toEqual({ highest: 9, lowest: 8, unscored: 0 });
    expect(r.trimmedScores).toEqual({ highest: 3, lowest: 3, unscored: 1 });
  });
});

describe("the printed report", () => {
  it("has the counts before and after, says it is a dry run, and how to go on", async () => {
    const r = await runTrimQueue(fakeStore(queue(212), { skippedAlready: 340 }).store, { keep: 30, apply: false });
    const text = formatTrim(r);
    expect(text).toContain("DRY RUN: nothing was changed. Add --apply to do it.");
    expect(text).toMatch(/Before:\s+'new-relevant'\s+212\s+'skipped'\s+340/);
    expect(text).toMatch(/After \(would be\):\s+'new-relevant'\s+30\s+'skipped'\s+522/);
    expect(text).toContain("Would trim 182 to 'skipped' with classify_reason 'trimmed_backlog'");
    expect(text).toContain("Nothing is deleted");
  });

  it("after --apply it says what was done and prints the counts read afterwards", async () => {
    const r = await runTrimQueue(fakeStore(queue(212), { skippedAlready: 340 }).store, { keep: 30, apply: true });
    const text = formatTrim(r);
    expect(text).toContain("APPLIED: items were changed.");
    expect(text).toContain("Trimmed 182 to 'skipped'");
    expect(text).toMatch(/After:\s+'new-relevant'\s+30\s+'skipped'\s+522/);
  });

  it("says so when there is nothing to trim", async () => {
    expect(formatTrim(await runTrimQueue(fakeStore(queue(5)).store, { keep: 30, apply: false }))).toContain("Nothing to trim");
  });
});

describe("the script", () => {
  const script = readFileSync(new URL("../../scripts/trim-queue.ts", import.meta.url), "utf8");
  const runStage = readFileSync(new URL("../../scripts/run-stage.ts", import.meta.url), "utf8");

  it("is reached through npm run stage, before the dev-server checks", () => {
    expect(runStage).toContain('process.argv[2] === "trim-queue"');
    expect(runStage.indexOf('"trim-queue"')).toBeLessThan(runStage.indexOf("parseStageArgs(process.argv"));
  });

  it("only moves items out of 'new-relevant' (never deletes), and only those still waiting", () => {
    expect(script).not.toMatch(/\.delete\(/);
    expect(script).toMatch(/\.update\(\{ status: "skipped", classify_reason: reason \}\)\.in\("id", ids\)\.eq\("status", "new-relevant"\)/);
  });

  it("prints which database it is talking to before it does anything", () => {
    expect(script.indexOf("Database: ")).toBeLessThan(script.indexOf("runTrimQueue(store"));
  });
});
