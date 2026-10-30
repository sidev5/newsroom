import { describe, expect, it, vi } from "vitest";
import { formatSummary, runAll, type StageBody, type StageCall } from "./run-all";
import type { StageName } from "./stage-names";

const ok = (body: StageBody): StageCall => ({ ok: true, body });

/** Each stage gets a script of responses, one per call. */
function scripted(script: Partial<Record<StageName, StageCall[]>>) {
  const calls: StageName[] = [];
  const callStage = async (stage: StageName): Promise<StageCall> => {
    calls.push(stage);
    const next = script[stage]?.shift();
    return next ?? ok({ processed: 0, remaining: 0 });
  };
  return { calls, callStage };
}

const noSleep = async () => {};

describe("runAll", () => {
  it("runs the stages in order and repeats a stage until its queue is empty", async () => {
    const { calls, callStage } = scripted({
      ingest: [ok({ processed: 20, remaining: 5 }), ok({ processed: 5, remaining: 0 })],
      classify: [ok({ processed: 25, remaining: 10, rejected: 20 }), ok({ processed: 10, remaining: 0, rejected: 8 })],
      write: [ok({ processed: 7, remaining: 0, rejected: 1 })],
      image: [ok({ processed: 7, remaining: 0 })],
      factcheck: [ok({ processed: 7, remaining: 0, rejected: 2 })],
    });
    const rows = await runAll(callStage, { sleep: noSleep });
    expect(calls).toEqual(["ingest", "ingest", "classify", "classify", "write", "image", "factcheck"]);
    expect(rows.map((r) => [r.stage, r.calls, r.processed, r.remaining, r.rejected, r.outcome])).toEqual([
      ["ingest", 2, 25, 0, 0, "done"],
      ["classify", 2, 35, 0, 28, "done"],
      ["write", 1, 7, 0, 1, "done"],
      ["image", 1, 7, 0, 0, "done"],
      ["factcheck", 1, 7, 0, 2, "done"],
    ]);
  });

  it("says why a stage stalled when the provider stopped it", async () => {
    const { callStage } = scripted({
      write: [ok({ processed: 0, remaining: 3, stopped: "provider_error", stoppedError: "gemini gemini-3.8-flash, attempt 1 of 4: HTTP 504 DEADLINE_EXCEEDED: Deadline expired" })],
    });
    const rows = await runAll(callStage, { sleep: noSleep });
    const write = rows.find((r) => r.stage === "write")!;
    expect(write).toMatchObject({ outcome: "stalled", error: "provider_error: gemini gemini-3.8-flash, attempt 1 of 4: HTTP 504 DEADLINE_EXCEEDED: Deadline expired" });
    expect(formatSummary(rows)).toContain("stalled: provider_error: gemini gemini-3.8-flash");
  });

  it("stops repeating a rate-limited stage, keeps what is left as remaining, and moves on", async () => {
    const { calls, callStage } = scripted({
      classify: [ok({ processed: 25, remaining: 30 }), ok({ processed: 5, remaining: 25, rateLimited: true })],
    });
    const rows = await runAll(callStage, { sleep: noSleep });
    expect(calls.filter((s) => s === "classify")).toHaveLength(2);
    expect(rows[1]).toMatchObject({ stage: "classify", processed: 30, remaining: 25, outcome: "rate-limited" });
    expect(calls).toContain("factcheck"); // later stages still run
  });

  it("stops a stage that has items waiting but makes no progress", async () => {
    const { calls, callStage } = scripted({ write: [ok({ processed: 0, remaining: 4 })] });
    const rows = await runAll(callStage, { sleep: noSleep });
    expect(calls.filter((s) => s === "write")).toHaveLength(1);
    expect(rows[2]).toMatchObject({ outcome: "stalled", remaining: 4 });
  });

  it("caps the calls per stage", async () => {
    const forever = Array.from({ length: 10 }, () => ok({ processed: 1, remaining: 99 }));
    const { callStage } = scripted({ image: forever });
    const rows = await runAll(callStage, { maxCalls: 3, sleep: noSleep });
    expect(rows[3]).toMatchObject({ stage: "image", calls: 3, outcome: "max-calls" });
  });

  it("reports an HTTP error and carries on with the next stage", async () => {
    const { calls, callStage } = scripted({ ingest: [{ ok: false, body: null, error: "500 boom" }] });
    const rows = await runAll(callStage, { sleep: noSleep });
    expect(rows[0]).toMatchObject({ outcome: "error", error: "500 boom" });
    expect(calls).toContain("classify");
  });

  it("pauses between repeated calls to one stage", async () => {
    const sleep = vi.fn(noSleep);
    const { callStage } = scripted({ classify: [ok({ processed: 5, remaining: 5 }), ok({ processed: 5, remaining: 0 })] });
    await runAll(callStage, { pauseMs: 1500, sleep });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1500);
  });
});

describe("formatSummary", () => {
  it("prints processed, remaining and rejected per stage", async () => {
    const rows = await runAll(
      scripted({ classify: [ok({ processed: 25, remaining: 3, rejected: 20, rateLimited: true })] }).callStage,
      { sleep: noSleep },
    );
    const text = formatSummary(rows);
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/stage\s+calls\s+processed\s+remaining\s+rejected\s+failed\s+result/);
    expect(lines).toHaveLength(2 + 5);
    expect(lines.find((l) => l.startsWith("classify"))).toMatch(/25\s+3\s+20\s+0\s+rate-limited/);
  });
});
