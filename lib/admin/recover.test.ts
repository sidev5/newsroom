import { describe, expect, it, vi } from "vitest";
import { runOneStage, type BatchDeps } from "./pipeline";
import {
  bulkMarkRelevant,
  bulkRestore,
  flaggedClaims,
  markedReason,
  markRelevant,
  restoreArticle,
  restoreNote,
  type RecoverDeps,
  type RejectedInfo,
  type SkippedInfo,
} from "./recover";
import { MAX_BULK } from "./review";
import { parseTab, rejectionInfo, summarizeRun } from "./review-view";

const NOW = new Date("2026-10-15T09:30:00.000Z");
const ADMIN = "editor@example.com";

type Setup = {
  admin?: string | null;
  rejected?: Record<string, RejectedInfo>;
  skipped?: Record<string, SkippedInfo>;
  departments?: string[];
  changed?: (id: string) => number;
  logFails?: boolean;
};

function setup(o: Setup = {}) {
  const rejected = new Map(Object.entries(o.rejected ?? {}));
  const skipped = new Map(Object.entries(o.skipped ?? {}));
  const restore = vi.fn<RecoverDeps["restore"]>(async (id) => (o.changed ? o.changed(id) : 1));
  const markRel = vi.fn<RecoverDeps["markRelevant"]>(async (id) => (o.changed ? o.changed(id) : 1));
  const loadRejected = vi.fn<RecoverDeps["loadRejected"]>(async () => rejected);
  const loadSkipped = vi.fn<RecoverDeps["loadSkipped"]>(async () => skipped);
  const departmentIds = vi.fn<RecoverDeps["departmentIds"]>(async () => new Set(o.departments ?? ["d-ev", "d-world"]));
  const log = vi.fn<RecoverDeps["log"]>(async () => {
    if (o.logFails) throw new Error("log down");
  });
  const d: RecoverDeps = {
    adminEmail: async () => (o.admin === undefined ? ADMIN : o.admin),
    loadRejected,
    restore,
    loadSkipped,
    departmentIds,
    markRelevant: markRel,
    log,
    now: () => NOW,
  };
  return { d, restore, markRel, loadRejected, loadSkipped, departmentIds, log };
}

const factChecked: RejectedInfo = { fact_check_notes: "- Wrong date\n- Invented quote", editor_reason: null };
const skippedItem: SkippedInfo = { status: "skipped", department_id: "d-ev", classify_reason: "Not relevant to EVs." };

// ---------------------------------------------------------------------------
// Permission checks: nothing, not even a read with the service role, before the admin check
// ---------------------------------------------------------------------------
describe("permission checks", () => {
  it.each([
    ["restore", (d: RecoverDeps) => restoreArticle("a1", d)],
    ["bulk restore", (d: RecoverDeps) => bulkRestore(["a1", "a2"], d)],
    ["mark relevant", (d: RecoverDeps) => markRelevant("r1", "d-ev", d)],
    ["bulk mark relevant", (d: RecoverDeps) => bulkMarkRelevant(["r1", "r2"], "d-ev", d)],
  ])("%s is refused for a non-admin and touches nothing", async (_n, act) => {
    const s = setup({ admin: null, rejected: { a1: factChecked }, skipped: { r1: skippedItem } });
    expect(await act(s.d)).toEqual({ ok: false, error: "Not authorised." });
    expect(s.loadRejected).not.toHaveBeenCalled();
    expect(s.loadSkipped).not.toHaveBeenCalled();
    expect(s.departmentIds).not.toHaveBeenCalled();
    expect(s.restore).not.toHaveBeenCalled();
    expect(s.markRel).not.toHaveBeenCalled();
    expect(s.log).not.toHaveBeenCalled();
  });

  it("runOneStage (the Run next batch button) runs nothing for a non-admin", async () => {
    const run = vi.fn(async () => ({}));
    const d: BatchDeps = { adminEmail: async () => null, runStage: run };
    expect(await runOneStage("write", d)).toEqual({ ok: false, error: "Not authorised." });
    expect(run).not.toHaveBeenCalled();
  });

  it("runOneStage runs the one stage as the admin", async () => {
    const run = vi.fn(async () => ({ processed: 5, remaining: 2 }));
    const r = await runOneStage("write", { adminEmail: async () => ADMIN, runStage: run });
    expect(run).toHaveBeenCalledWith("write", ADMIN);
    expect(r).toEqual({ ok: true, outcome: { stage: "write", ok: true, summary: { processed: 5, remaining: 2 } } });
  });
});

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------
describe("restoreArticle", () => {
  it("moves rejected -> pending_review with a visible note, and does not touch the fact-check report", async () => {
    const s = setup({ rejected: { a1: factChecked } });
    expect(await restoreArticle("a1", s.d)).toEqual({ ok: true });
    expect(s.restore).toHaveBeenCalledTimes(1);
    const [id, patch] = s.restore.mock.calls[0];
    expect(id).toBe("a1");
    expect(patch).toEqual({
      status: "pending_review",
      review_note: "Restored by an editor, fact-check had flagged: Wrong date; Invented quote",
    });
    expect(patch).not.toHaveProperty("fact_check_notes"); // kept as it was
  });

  it("writes an audit entry with who, when and the previous status", async () => {
    const s = setup({ rejected: { a1: factChecked } });
    await restoreArticle("a1", s.d);
    expect(s.log).toHaveBeenCalledWith([
      { article_id: "a1", action: "restore", actor_email: ADMIN, reason: null, bulk: false, created_at: NOW.toISOString(), previous_status: "rejected" },
    ]);
  });

  it("refuses an article that is not rejected (any more) and logs nothing", async () => {
    const none = setup({ rejected: {} });
    expect(await restoreArticle("a1", none.d)).toEqual({ ok: false, error: "This article is no longer rejected." });
    expect(none.restore).not.toHaveBeenCalled();
    expect(none.log).not.toHaveBeenCalled();
    // Lost a race: the guarded update changed no row.
    const raced = setup({ rejected: { a1: factChecked }, changed: () => 0 });
    expect(await restoreArticle("a1", raced.d)).toMatchObject({ ok: false });
    expect(raced.log).not.toHaveBeenCalled();
  });

  it("needs an id", async () => {
    const s = setup();
    expect(await restoreArticle("", s.d)).toEqual({ ok: false, error: "Nothing selected." });
  });

  it("reports a database error instead of throwing", async () => {
    const s = setup({ rejected: { a1: factChecked } });
    s.restore.mockRejectedValueOnce(new Error("db down"));
    expect(await restoreArticle("a1", s.d)).toEqual({ ok: false, error: "Update failed: db down" });
    expect(s.log).not.toHaveBeenCalled();
  });

  it("still succeeds, with a warning, if only the audit write fails", async () => {
    const s = setup({ rejected: { a1: factChecked }, logFails: true });
    const r = await restoreArticle("a1", s.d);
    expect(r.ok && r.warning).toContain("audit log");
  });
});

describe("bulkRestore", () => {
  it("restores each selected article and logs one bulk entry per article", async () => {
    const s = setup({ rejected: { a1: factChecked, a2: { fact_check_notes: null, editor_reason: "duplicate" } } });
    expect(await bulkRestore(["a1", "a2", "a1"], s.d)).toEqual({ ok: true, done: 2, failed: [] });
    expect(s.restore).toHaveBeenCalledTimes(2);
    const entries = s.log.mock.calls[0][0];
    expect(entries).toHaveLength(1 * 2);
    expect(entries.every((e) => e.action === "restore" && e.bulk && e.actor_email === ADMIN && e.previous_status === "rejected" && e.created_at === NOW.toISOString())).toBe(true);
  });

  it("reports the ones it could not restore and logs only the ones it did", async () => {
    const s = setup({ rejected: { a1: factChecked } }); // a2 is not rejected
    const r = await bulkRestore(["a1", "a2"], s.d);
    expect(r).toEqual({ ok: true, done: 1, failed: [{ id: "a2", error: "This article is no longer rejected." }] });
    expect(s.log.mock.calls[0][0].map((e) => e.article_id)).toEqual(["a1"]);
  });

  it("refuses an empty or oversized selection", async () => {
    const s = setup();
    expect(await bulkRestore([], s.d)).toEqual({ ok: false, error: "Nothing selected." });
    expect(await bulkRestore(Array.from({ length: MAX_BULK + 1 }, (_, i) => `a${i}`), s.d)).toMatchObject({ ok: false });
    expect(s.loadRejected).not.toHaveBeenCalled();
  });
});

describe("notes", () => {
  it("lists the flagged claims, or names the editor's reason, or says there was none", () => {
    expect(restoreNote(factChecked)).toBe("Restored by an editor, fact-check had flagged: Wrong date; Invented quote");
    expect(restoreNote({ fact_check_notes: null, editor_reason: "off topic" })).toContain("rejected by an editor: off topic");
    expect(restoreNote({ fact_check_notes: null, editor_reason: null })).toContain("no recorded reason");
    expect(restoreNote({ fact_check_notes: "- " + "x".repeat(5000), editor_reason: null }).length).toBeLessThanOrEqual(1500);
    expect(flaggedClaims(" - a\n\n-  b ")).toEqual(["a", "b"]);
    expect(flaggedClaims(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Mark relevant
// ---------------------------------------------------------------------------
describe("markRelevant", () => {
  it("sets skipped -> new-relevant with the picked department, keeping the classifier's reason in the text", async () => {
    const s = setup({ skipped: { r1: skippedItem } });
    expect(await markRelevant("r1", "d-world", s.d)).toEqual({ ok: true });
    expect(s.markRel).toHaveBeenCalledWith("r1", {
      status: "new-relevant",
      department_id: "d-world",
      classify_reason: `marked relevant by ${ADMIN} (was: Not relevant to EVs.)`,
    });
  });

  it("keeps the classifier's department guess when none is picked", async () => {
    const s = setup({ skipped: { r1: skippedItem } });
    await markRelevant("r1", null, s.d);
    expect(s.markRel.mock.calls[0][1]).toMatchObject({ department_id: "d-ev" });
  });

  it("needs a department when there is no guess, and writes nothing", async () => {
    const s = setup({ skipped: { r1: { ...skippedItem, department_id: null } } });
    expect(await markRelevant("r1", null, s.d)).toMatchObject({ ok: false, error: expect.stringContaining("Pick a department") });
    expect(s.markRel).not.toHaveBeenCalled();
    expect(s.log).not.toHaveBeenCalled();
  });

  it("refuses a department that does not exist", async () => {
    const s = setup({ skipped: { r1: skippedItem } });
    expect(await markRelevant("r1", "d-made-up", s.d)).toEqual({ ok: false, error: "Unknown department." });
    expect(s.markRel).not.toHaveBeenCalled();
  });

  it("logs who, when, the raw item and its previous status", async () => {
    const s = setup({ skipped: { r1: { ...skippedItem, status: "failed" } } });
    await markRelevant("r1", null, s.d);
    expect(s.log).toHaveBeenCalledWith([
      {
        article_id: null,
        raw_item_id: "r1",
        action: "mark_relevant",
        actor_email: ADMIN,
        reason: "Not relevant to EVs.",
        bulk: false,
        created_at: NOW.toISOString(),
        previous_status: "failed",
      },
    ]);
  });

  it("refuses an item that is no longer skipped or failed", async () => {
    const gone = setup({ skipped: {} });
    expect(await markRelevant("r1", "d-ev", gone.d)).toEqual({ ok: false, error: "This item is no longer skipped or failed." });
    const raced = setup({ skipped: { r1: skippedItem }, changed: () => 0 });
    expect(await markRelevant("r1", "d-ev", raced.d)).toMatchObject({ ok: false });
    expect(raced.log).not.toHaveBeenCalled();
  });

  it("caps a very long classifier reason", () => {
    expect(markedReason("a@b.c", "x".repeat(900)).length).toBe(500);
    expect(markedReason("a@b.c", null)).toBe("marked relevant by a@b.c");
  });
});

describe("bulkMarkRelevant", () => {
  const items = { r1: skippedItem, r2: { ...skippedItem, department_id: "d-world" }, r3: { ...skippedItem, department_id: null } };

  it("uses each item's own guess when no department is picked, and reports one with none", async () => {
    const s = setup({ skipped: items });
    const r = await bulkMarkRelevant(["r1", "r2", "r3"], null, s.d);
    expect(r).toMatchObject({ ok: true, done: 2, failed: [{ id: "r3" }] });
    expect(s.markRel.mock.calls.map(([id, p]) => [id, p.department_id])).toEqual([["r1", "d-ev"], ["r2", "d-world"]]);
    expect(s.log.mock.calls[0][0].every((e) => e.bulk && e.action === "mark_relevant" && e.actor_email === ADMIN)).toBe(true);
  });

  it("applies one picked department to every selected item", async () => {
    const s = setup({ skipped: items });
    const r = await bulkMarkRelevant(["r1", "r2", "r3"], "d-world", s.d);
    expect(r).toMatchObject({ ok: true, done: 3, failed: [] });
    expect(s.markRel.mock.calls.every(([, p]) => p.department_id === "d-world" && p.status === "new-relevant")).toBe(true);
  });

  it("refuses an empty or oversized selection", async () => {
    const s = setup();
    expect(await bulkMarkRelevant([], "d-ev", s.d)).toEqual({ ok: false, error: "Nothing selected." });
    expect(await bulkMarkRelevant(Array.from({ length: MAX_BULK + 1 }, (_, i) => `r${i}`), "d-ev", s.d)).toMatchObject({ ok: false });
    expect(s.loadSkipped).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// View helpers
// ---------------------------------------------------------------------------
describe("view helpers for the new tabs", () => {
  it("knows the skipped tab", () => {
    expect(parseTab("skipped")).toBe("skipped");
    expect(parseTab("nope")).toBe("pending");
  });

  it("names the editor when an editor rejected it last, even if a fact-check report exists", () => {
    const log = { action: "reject", actor_email: "e@x.com", reason: "still wrong", created_at: "2026-10-15T08:00:00Z" };
    expect(rejectionInfo("- Wrong date", log)).toEqual({ source: "editor", reason: "still wrong", by: "e@x.com", at: log.created_at, claims: ["Wrong date"] });
    expect(rejectionInfo("- Wrong date", { ...log, action: "restore" })).toEqual({ source: "fact-check", claims: ["Wrong date"] });
  });

  it("summarises a stage run", () => {
    expect(summarizeRun({ processed: 5, remaining: 12, rejected: 2, failed: 0, rateLimited: true })).toBe("processed 5 · remaining 12 · rejected 2 · rate limited");
    expect(summarizeRun({ totals: { inserted: 1 } })).toContain("totals");
    expect(summarizeRun(null)).toBe("null");
  });
});
