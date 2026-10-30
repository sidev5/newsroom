import { describe, expect, it, vi } from "vitest";
import { restoreArticle, type RecoverDeps } from "./recover";
import {
  approveArticle,
  bulkApprove,
  bulkReject,
  EMPLOYEE_REASON_REQUIRED,
  rejectArticle,
  unpublishArticle,
  type ReviewDeps,
  type ReviewLogEntry,
} from "./review";
import { filterByChip, parseChip, pendingChips } from "./review-view";

const NOW = new Date("2026-10-15T09:30:00.000Z");
const ADMIN = "editor@example.com";
const PUBLIC_PHOTO = "https://abc.supabase.co/storage/v1/object/public/article-images/11111111.webp";

type Article = { status: "pending_review" | "published" | "rejected"; origin: "ai" | "employee"; image_url: string | null; hasPhoto: boolean; published_at?: string | null };

/** A tiny database behind the review dependencies: status changes are guarded the way the real updates are. */
function setup(articles: Record<string, Article>, o: { admin?: string | null; photoFails?: string[]; employeeLookupFails?: boolean } = {}) {
  const db = new Map(Object.entries(articles));
  const logs: ReviewLogEntry[] = [];
  const beforePublish = vi.fn<NonNullable<ReviewDeps["beforePublish"]>>(async (id): Promise<Record<string, string | null>> => {
    if (o.photoFails?.includes(id)) throw new Error("storage is down");
    const a = db.get(id);
    return a?.origin === "employee" && a.hasPhoto && !a.image_url ? { image_url: PUBLIC_PHOTO } : {};
  });
  const update = vi.fn<ReviewDeps["update"]>(async (id, patch) => {
    const a = db.get(id);
    if (!a || a.status !== "pending_review") return 0;
    Object.assign(a, patch);
    return 1;
  });
  const unpublish = vi.fn<ReviewDeps["unpublish"]>(async (id) => {
    const a = db.get(id);
    if (!a || a.status !== "published") return 0;
    a.status = "pending_review";
    a.published_at = null;
    return 1;
  });
  const employeeIds = vi.fn<NonNullable<ReviewDeps["employeeIds"]>>(async (ids) => {
    if (o.employeeLookupFails) throw new Error("no origin column");
    return new Set(ids.filter((id) => db.get(id)?.origin === "employee"));
  });
  const d: ReviewDeps = {
    adminEmail: async () => (o.admin === undefined ? ADMIN : o.admin),
    update,
    unpublish,
    log: async (entries) => void logs.push(...entries),
    now: () => NOW,
    employeeIds,
    beforePublish,
  };
  return { d, db, logs, beforePublish, update, employeeIds };
}

const employee = (over: Partial<Article> = {}): Article => ({ status: "pending_review", origin: "employee", image_url: null, hasPhoto: true, ...over });
const ai = (over: Partial<Article> = {}): Article => ({ status: "pending_review", origin: "ai", image_url: "https://images.unsplash.com/x", hasPhoto: false, ...over });
const edits = { headline: "A headline", body: "A body" };

describe("approving an employee story", () => {
  it("publishes it like any other story: published_at set, audit log written, photo moved to the public bucket", async () => {
    const t = setup({ e1: employee() });
    expect(await approveArticle("e1", edits, t.d)).toEqual({ ok: true });
    expect(t.db.get("e1")).toMatchObject({ status: "published", published_at: NOW.toISOString(), image_url: PUBLIC_PHOTO });
    expect(t.logs).toEqual([{ article_id: "e1", action: "approve", actor_email: ADMIN, reason: null, bulk: false, created_at: NOW.toISOString() }]);
  });

  it("saves the admin's inline edits of the title and text in the same update", async () => {
    const t = setup({ e1: employee() });
    await approveArticle("e1", { headline: "  Fixed title ", body: " Fixed text " }, t.d);
    expect(t.update).toHaveBeenCalledWith("e1", { status: "published", published_at: NOW.toISOString(), headline: "Fixed title", body: "Fixed text", summary: "Fixed text", image_url: PUBLIC_PHOTO });
  });

  it("keeps the department default image for a story without a photo", async () => {
    const t = setup({ e1: employee({ hasPhoto: false, image_url: "/images/defaults/ev.svg" }) });
    await approveArticle("e1", edits, t.d);
    expect(t.db.get("e1")!.image_url).toBe("/images/defaults/ev.svg");
  });

  it("does not publish if the photo cannot be moved, and says why", async () => {
    const t = setup({ e1: employee() }, { photoFails: ["e1"] });
    const r = await approveArticle("e1", edits, t.d);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("storage is down") });
    expect(t.update).not.toHaveBeenCalled();
    expect(t.db.get("e1")!.status).toBe("pending_review");
    expect(t.logs).toHaveLength(0);
  });

  it("does not touch the photo when the edits are invalid", async () => {
    const t = setup({ e1: employee() });
    expect(await approveArticle("e1", { headline: " ", body: "x" }, t.d)).toMatchObject({ ok: false });
    expect(t.beforePublish).not.toHaveBeenCalled();
  });

  it("is refused for a non-admin without touching storage or the database", async () => {
    const t = setup({ e1: employee() }, { admin: null });
    expect(await approveArticle("e1", edits, t.d)).toEqual({ ok: false, error: "Not authorised." });
    expect(t.beforePublish).not.toHaveBeenCalled();
    expect(t.update).not.toHaveBeenCalled();
    expect(t.db.get("e1")!.status).toBe("pending_review");
  });

  it("cannot be approved twice", async () => {
    const t = setup({ e1: employee() });
    await approveArticle("e1", edits, t.d);
    expect(await approveArticle("e1", edits, t.d)).toEqual({ ok: false, error: "This article is no longer pending review." });
    expect(t.logs).toHaveLength(1);
  });

  it("goes back to pending when unpublished, and keeps its public photo on re-approval", async () => {
    const t = setup({ e1: employee() });
    await approveArticle("e1", edits, t.d);
    expect(await unpublishArticle("e1", t.d)).toEqual({ ok: true });
    expect(t.db.get("e1")).toMatchObject({ status: "pending_review", published_at: null, image_url: PUBLIC_PHOTO });
    await approveArticle("e1", edits, t.d);
    expect(t.db.get("e1")!.status).toBe("published");
  });

  it("an AI article is approved exactly as before (no extra columns)", async () => {
    const t = setup({ a1: ai() });
    await approveArticle("a1", undefined, t.d);
    expect(t.update).toHaveBeenCalledWith("a1", { status: "published", published_at: NOW.toISOString() });
  });
});

describe("rejecting an employee story", () => {
  it("needs a reason, and writes nothing without one", async () => {
    const t = setup({ e1: employee() });
    expect(await rejectArticle("e1", t.d)).toEqual({ ok: false, error: EMPLOYEE_REASON_REQUIRED });
    expect(await rejectArticle("e1", t.d, "   ")).toEqual({ ok: false, error: EMPLOYEE_REASON_REQUIRED });
    expect(t.update).not.toHaveBeenCalled();
    expect(t.db.get("e1")!.status).toBe("pending_review");
  });

  it("records the reason in the audit log", async () => {
    const t = setup({ e1: employee() });
    expect(await rejectArticle("e1", t.d, "Contains a customer name")).toEqual({ ok: true });
    expect(t.db.get("e1")!.status).toBe("rejected");
    expect(t.logs).toEqual([{ article_id: "e1", action: "reject", actor_email: ADMIN, reason: "Contains a customer name", bulk: false, created_at: NOW.toISOString() }]);
  });

  it("keeps the reason optional for AI articles", async () => {
    const t = setup({ a1: ai() });
    expect(await rejectArticle("a1", t.d)).toEqual({ ok: true });
  });

  it("is refused for a non-admin", async () => {
    const t = setup({ e1: employee() }, { admin: null });
    expect(await rejectArticle("e1", t.d, "reason")).toEqual({ ok: false, error: "Not authorised." });
    expect(t.employeeIds).not.toHaveBeenCalled();
    expect(t.update).not.toHaveBeenCalled();
  });

  it("does not block rejecting when the employee lookup itself fails", async () => {
    const t = setup({ a1: ai() }, { employeeLookupFails: true });
    expect(await rejectArticle("a1", t.d)).toEqual({ ok: true });
  });
});

describe("bulk actions with employee stories", () => {
  it("bulk reject without a reason rejects the AI articles and refuses the employee ones", async () => {
    const t = setup({ e1: employee(), a1: ai(), a2: ai() });
    const r = await bulkReject(["e1", "a1", "a2"], undefined, t.d);
    expect(r).toMatchObject({ ok: true, done: 2, failed: [{ id: "e1", error: EMPLOYEE_REASON_REQUIRED }] });
    expect(t.db.get("e1")!.status).toBe("pending_review");
    expect(t.db.get("a1")!.status).toBe("rejected");
  });

  it("bulk reject with a reason rejects them all", async () => {
    const t = setup({ e1: employee(), a1: ai() });
    expect(await bulkReject(["e1", "a1"], "Out of scope", t.d)).toMatchObject({ ok: true, done: 2, failed: [] });
    expect(t.logs.map((l) => l.reason)).toEqual(["Out of scope", "Out of scope"]);
  });

  it("bulk approve moves each employee photo, and one failing photo fails only that story", async () => {
    const t = setup({ e1: employee(), e2: employee(), a1: ai() }, { photoFails: ["e2"] });
    const r = await bulkApprove(["e1", "e2", "a1"], t.d);
    expect(r).toMatchObject({ ok: true, done: 2, failed: [{ id: "e2", error: expect.stringContaining("storage is down") }] });
    expect(t.db.get("e1")).toMatchObject({ status: "published", image_url: PUBLIC_PHOTO });
    expect(t.db.get("e2")!.status).toBe("pending_review");
    expect(t.db.get("a1")!.status).toBe("published");
  });
});

describe("restoring a rejected employee story", () => {
  it("puts it back in Pending with a note that carries the rejection reason", async () => {
    const restore = vi.fn<RecoverDeps["restore"]>(async () => 1);
    const log = vi.fn<RecoverDeps["log"]>(async () => {});
    const d: RecoverDeps = {
      adminEmail: async () => ADMIN,
      loadRejected: async () => new Map([["e1", { fact_check_notes: null, editor_reason: "Contains a customer name" }]]),
      restore,
      loadSkipped: async () => new Map(),
      departmentIds: async () => new Set(),
      markRelevant: async () => 1,
      log,
      now: () => NOW,
    };
    expect(await restoreArticle("e1", d)).toEqual({ ok: true });
    expect(restore).toHaveBeenCalledWith("e1", { status: "pending_review", review_note: expect.stringContaining("Contains a customer name") });
    expect(log).toHaveBeenCalledWith([expect.objectContaining({ article_id: "e1", action: "restore", previous_status: "rejected" })]);
  });
});

describe("the Employee submissions chip", () => {
  const depts = [
    { slug: "ev", name: "EV" },
    { slug: "ai-technology", name: "AI & Technology" },
  ];
  const rows = [
    { department: { slug: "ev" }, origin: "ai" as const },
    { department: { slug: "ai-technology" }, origin: "employee" as const },
    { department: { slug: "ev" }, origin: "employee" as const },
  ];

  it("shows right after All, with the number of pending employee stories", () => {
    const chips = pendingChips(rows, depts);
    expect(chips.slice(0, 2)).toEqual([
      { key: "all", label: "All", count: 3 },
      { key: "employee", label: "Employee submissions", count: 2 },
    ]);
  });

  it("filters to the employee stories, across departments", () => {
    expect(filterByChip(rows, "employee")).toHaveLength(2);
    expect(filterByChip(rows, "ev")).toHaveLength(2);
    expect(parseChip("employee", pendingChips(rows, depts))).toBe("employee");
  });

  it("counts zero when there are none, and lists AI & Technology like any department", () => {
    const chips = pendingChips([{ department: { slug: "ev" } }], depts);
    expect(chips.find((c) => c.key === "employee")!.count).toBe(0);
    expect(chips.map((c) => c.label)).toContain("AI & Technology");
  });
});
