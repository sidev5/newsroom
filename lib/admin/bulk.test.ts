import { describe, expect, it, vi } from "vitest";
import { runNextBatch, type BatchDeps } from "./pipeline";
import {
  approveArticle,
  bulkApprove,
  bulkReject,
  MAX_BULK,
  rejectArticle,
  unpublishArticle,
  type ReviewDeps,
} from "./review";
import { chipLabel, countBy, filterByChip, formatUtc, funnel, parseChip, parseTab, pendingChips, rejectionInfo } from "./review-view";
import { runStage, STAGE_ORDER, type RunRecord } from "@/lib/pipeline/stages";

const NOW = new Date("2026-10-14T09:30:00.000Z");

function deps(admin: string | null, opts: { changed?: (id: string) => number; logFails?: boolean } = {}) {
  const update = vi.fn<ReviewDeps["update"]>(async (id) => (opts.changed ? opts.changed(id) : 1));
  const unpublish = vi.fn<ReviewDeps["unpublish"]>(async () => 1);
  const log = vi.fn<ReviewDeps["log"]>(async () => {
    if (opts.logFails) throw new Error("log down");
  });
  const d: ReviewDeps = { adminEmail: async () => admin, update, unpublish, log, now: () => NOW };
  return { d, update, unpublish, log };
}

describe("bulk actions: permission checks", () => {
  it.each([
    ["bulk approve", (d: ReviewDeps) => bulkApprove(["a1", "a2"], d)],
    ["bulk reject", (d: ReviewDeps) => bulkReject(["a1", "a2"], "spam", d)],
  ])("%s does nothing for a non-admin", async (_n, act) => {
    const { d, update, unpublish, log } = deps(null);
    expect(await act(d)).toEqual({ ok: false, error: "Not authorised." });
    expect(update).not.toHaveBeenCalled();
    expect(unpublish).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("unpublish and single reject with a reason also do nothing for a non-admin", async () => {
    const { d, update, unpublish, log } = deps(null);
    expect(await unpublishArticle("a1", d)).toEqual({ ok: false, error: "Not authorised." });
    expect(await rejectArticle("a1", d, "reason")).toEqual({ ok: false, error: "Not authorised." });
    expect(update).not.toHaveBeenCalled();
    expect(unpublish).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});

describe("bulkApprove", () => {
  it("publishes each pending article as stored and logs who and when", async () => {
    const { d, update, log } = deps("editor@example.com");
    expect(await bulkApprove(["a1", "a2"], d)).toEqual({ ok: true, done: 2, failed: [] });
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith("a1", { status: "published", published_at: NOW.toISOString() });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toEqual([
      { article_id: "a1", action: "approve", actor_email: "editor@example.com", reason: null, bulk: true, created_at: NOW.toISOString() },
      { article_id: "a2", action: "approve", actor_email: "editor@example.com", reason: null, bulk: true, created_at: NOW.toISOString() },
    ]);
  });

  it("ignores duplicates and blanks, and refuses an empty or oversized selection", async () => {
    const { d, update } = deps("editor@example.com");
    expect(await bulkApprove(["a1", "a1", "", 5, null], d)).toMatchObject({ ok: true, done: 1 });
    expect(update).toHaveBeenCalledTimes(1);
    expect(await bulkApprove([], d)).toEqual({ ok: false, error: "Nothing selected." });
    expect(await bulkApprove("a1", d)).toEqual({ ok: false, error: "Nothing selected." });
    const many = Array.from({ length: MAX_BULK + 1 }, (_, i) => `a${i}`);
    expect(await bulkApprove(many, d)).toMatchObject({ ok: false });
  });

  it("reports articles that are no longer pending and only logs the ones that changed", async () => {
    const { d, log } = deps("editor@example.com", { changed: (id) => (id === "a2" ? 0 : 1) });
    const r = await bulkApprove(["a1", "a2", "a3"], d);
    expect(r).toEqual({ ok: true, done: 2, failed: [{ id: "a2", error: "This article is no longer pending review." }] });
    expect(log.mock.calls[0][0].map((e) => e.article_id)).toEqual(["a1", "a3"]);
  });

  it("carries on after a database error on one article", async () => {
    const { d, update } = deps("editor@example.com");
    update.mockRejectedValueOnce(new Error("db down"));
    const r = await bulkApprove(["a1", "a2"], d);
    expect(r).toEqual({ ok: true, done: 1, failed: [{ id: "a1", error: "Update failed: db down" }] });
  });

  it("still reports success, with a warning, if only the audit log write fails", async () => {
    const { d } = deps("editor@example.com", { logFails: true });
    const r = await bulkApprove(["a1"], d);
    expect(r).toMatchObject({ ok: true, done: 1 });
    expect(r.ok && r.warning).toContain("audit log");
  });
});

describe("bulkReject", () => {
  it("sets status rejected and logs the trimmed reason on every row", async () => {
    const { d, update, log } = deps("editor@example.com");
    expect(await bulkReject(["a1", "a2"], "  off topic  ", d)).toMatchObject({ ok: true, done: 2 });
    expect(update).toHaveBeenCalledWith("a1", { status: "rejected" });
    const entries = log.mock.calls[0][0];
    expect(entries.every((e) => e.action === "reject" && e.reason === "off topic" && e.bulk && e.actor_email === "editor@example.com")).toBe(true);
  });

  it("treats a blank reason as none and caps a long one", async () => {
    const a = deps("editor@example.com");
    await bulkReject(["a1"], "   ", a.d);
    expect(a.log.mock.calls[0][0][0].reason).toBeNull();
    const b = deps("editor@example.com");
    await bulkReject(["a1"], "x".repeat(900), b.d);
    expect(b.log.mock.calls[0][0][0].reason).toHaveLength(500);
  });
});

describe("single actions are logged too", () => {
  it("approve logs who and when", async () => {
    const { d, log } = deps("editor@example.com");
    await approveArticle("a1", { headline: "H", body: "B" }, d);
    expect(log).toHaveBeenCalledWith([
      { article_id: "a1", action: "approve", actor_email: "editor@example.com", reason: null, bulk: false, created_at: NOW.toISOString() },
    ]);
  });

  it("reject logs the reason; a failed update logs nothing", async () => {
    const ok = deps("editor@example.com");
    await rejectArticle("a1", ok.d, "duplicate");
    expect(ok.log.mock.calls[0][0][0]).toMatchObject({ action: "reject", reason: "duplicate" });
    const none = deps("editor@example.com", { changed: () => 0 });
    expect(await rejectArticle("a1", none.d)).toMatchObject({ ok: false });
    expect(none.log).not.toHaveBeenCalled();
  });

  it("unpublish returns the article to review and is logged", async () => {
    const { d, unpublish, update, log } = deps("editor@example.com");
    expect(await unpublishArticle("a1", d)).toEqual({ ok: true });
    expect(unpublish).toHaveBeenCalledWith("a1");
    expect(update).not.toHaveBeenCalled();
    expect(log.mock.calls[0][0][0]).toMatchObject({ action: "unpublish", actor_email: "editor@example.com" });
  });

  it("unpublish reports an article that is not published", async () => {
    const { d, unpublish, log } = deps("editor@example.com");
    unpublish.mockResolvedValueOnce(0);
    expect(await unpublishArticle("a1", d)).toEqual({ ok: false, error: "This article is no longer published." });
    expect(log).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Run next batch
// ---------------------------------------------------------------------------
describe("runNextBatch", () => {
  it("runs no stage for a non-admin", async () => {
    const run = vi.fn(async () => ({}));
    const d: BatchDeps = { adminEmail: async () => null, runStage: run };
    expect(await runNextBatch(d)).toEqual({ ok: false, error: "Not authorised." });
    expect(run).not.toHaveBeenCalled();
  });

  it("runs every stage in order, triggered by the admin", async () => {
    const order: string[] = [];
    const d: BatchDeps = {
      adminEmail: async () => "editor@example.com",
      runStage: async (stage, by) => {
        order.push(`${stage}:${by}`);
        return { processed: 1 };
      },
    };
    const r = await runNextBatch(d);
    expect(order).toEqual(["ingest", "classify", "write", "image", "factcheck"].map((s) => `${s}:editor@example.com`));
    expect(r.ok && r.stages.every((s) => s.ok)).toBe(true);
  });

  it("reports a failing stage and still runs the rest", async () => {
    const d: BatchDeps = {
      adminEmail: async () => "editor@example.com",
      runStage: async (stage) => {
        if (stage === "write") throw new Error("llm down");
        return {};
      },
    };
    const r = await runNextBatch(d);
    expect(r.ok && r.stages.map((s) => [s.stage, s.ok])).toEqual([
      ["ingest", true],
      ["classify", true],
      ["write", false],
      ["image", true],
      ["factcheck", true],
    ]);
    expect(r.ok && r.stages[2].error).toBe("llm down");
  });
});

describe("runStage records the run", () => {
  it("saves a success with its summary and trigger", async () => {
    const saved: RunRecord[] = [];
    const out = await runStage("classify", "cron", { run: async () => ({ processed: 3 }), save: async (r) => void saved.push(r), now: () => NOW });
    expect(out).toEqual({ processed: 3 });
    expect(saved).toEqual([
      { stage: "classify", started_at: NOW.toISOString(), finished_at: NOW.toISOString(), ok: true, summary: { processed: 3 }, error: null, triggered_by: "cron" },
    ]);
  });

  it("saves a failure and rethrows it", async () => {
    const saved: RunRecord[] = [];
    await expect(
      runStage("write", "a@b.c", { run: async () => Promise.reject(new Error("boom")), save: async (r) => void saved.push(r), now: () => NOW }),
    ).rejects.toThrow("boom");
    expect(saved[0]).toMatchObject({ stage: "write", ok: false, error: "boom", triggered_by: "a@b.c" });
  });

  it("knows the stage order", () => {
    expect([...STAGE_ORDER]).toEqual(["ingest", "classify", "write", "image", "factcheck"]);
  });
});

// ---------------------------------------------------------------------------
// Pure view helpers
// ---------------------------------------------------------------------------
describe("review view helpers", () => {
  const depts = [
    { slug: "sales-marketing", name: "Sales & Marketing" },
    { slug: "ev", name: "EV" },
    { slug: "world", name: "World", kind: "world" as const },
    { slug: "software", name: "Software Development" },
    { slug: "defence", name: "Defence" },
    { slug: "batteries", name: "Batteries" },
    { slug: "ai-technology", name: "AI & Technology" },
  ];
  const row = (slug: string | null, origin: "ai" | "employee" = "ai") => ({ department: slug ? { slug } : null, origin });
  const rows = [row("ev"), row("ev"), row("world"), row("defence"), row(null)];

  it("builds chips in the fixed order with counts", () => {
    const chips = pendingChips(rows, depts);
    expect(chips.map((c) => `${c.label}:${c.count}`)).toEqual([
      "All:5",
      "Employee submissions:0",
      "World:1",
      "EV:2",
      "Batteries:0",
      "Defence:1",
      "Software:0",
      "Sales & Marketing:0",
      "AI & Technology:0",
    ]);
    expect(chipLabel({ slug: "software", name: "Software Development" })).toBe("Software");
  });

  it("filters by chip and falls back to all for an unknown key", () => {
    const chips = pendingChips(rows, depts);
    expect(filterByChip(rows, "ev")).toHaveLength(2);
    expect(filterByChip(rows, "all")).toHaveLength(5);
    expect(parseChip("nope", chips)).toBe("all");
    expect(parseChip(["ev"], chips)).toBe("all");
    expect(parseChip("world", chips)).toBe("world");
  });

  it("parses the tab", () => {
    expect(parseTab("rejected")).toBe("rejected");
    expect(parseTab("x")).toBe("pending");
    expect(parseTab(undefined)).toBe("pending");
  });

  it("explains a fact-check rejection with its claims, and an editor rejection with who and why", () => {
    expect(rejectionInfo("- Claim one\n- Claim two", null)).toEqual({ source: "fact-check", claims: ["Claim one", "Claim two"] });
    expect(rejectionInfo(null, { action: "reject", actor_email: "e@x.com", reason: "dup", created_at: "2026-10-14T09:00:00Z" })).toEqual({
      source: "editor",
      reason: "dup",
      by: "e@x.com",
      at: "2026-10-14T09:00:00Z",
    });
    expect(rejectionInfo(null, null)).toEqual({ source: "unknown" });
    expect(rejectionInfo("  ", { action: "approve", actor_email: "e", reason: null, created_at: "" })).toEqual({ source: "unknown" });
  });

  it("builds a funnel with zero for missing statuses", () => {
    const f = funnel(["new", "written"], { new: 10 });
    expect(f).toEqual([
      { status: "new", count: 10, share: 1 },
      { status: "written", count: 0, share: 0 },
    ]);
    expect(countBy([{ status: "a" }, { status: "a" }, { status: "b" }])).toEqual({ a: 2, b: 1 });
  });

  it("formats UTC times", () => {
    expect(formatUtc("2026-10-14T09:30:15Z")).toBe("2026-10-14 09:30 UTC");
    expect(formatUtc(null)).toBe("—");
    expect(formatUtc("nope")).toBe("—");
  });
});
