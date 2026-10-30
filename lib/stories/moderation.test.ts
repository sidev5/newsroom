import { describe, expect, it, vi } from "vitest";
import { hideComment, unhideComment, type ModerationDeps } from "./moderation";

const ID = "0b6f9a6e-2f4d-4d7e-9a53-3c1f0e8b7a11";

function setup(over: Partial<ModerationDeps> = {}) {
  const set = vi.fn(async () => ({ articleId: "a1" }));
  const log = vi.fn(async () => {});
  const deps: ModerationDeps = { adminEmail: async () => "editor@example.com", setStatus: set, log, now: () => new Date("2026-10-22T10:00:00Z"), ...over };
  return { deps, set, log };
}

describe("hiding and showing comments", () => {
  it("hides a comment and writes who did it, when and why to the log", async () => {
    const t = setup();
    expect(await hideComment(t.deps, ID, "  spam  ")).toEqual({ ok: true });
    expect(t.set).toHaveBeenCalledWith(ID, "hidden");
    expect(t.log).toHaveBeenCalledWith({ comment_id: ID, article_id: "a1", action: "hide", actor_email: "editor@example.com", reason: "spam", created_at: "2026-10-22T10:00:00.000Z" });
  });

  it("shows it again, and logs that as 'unhide'", async () => {
    const t = setup();
    expect(await unhideComment(t.deps, ID)).toEqual({ ok: true });
    expect(t.set).toHaveBeenCalledWith(ID, "visible");
    expect(t.log).toHaveBeenCalledWith(expect.objectContaining({ action: "unhide", reason: null }));
  });

  it("cuts a long reason and ignores one that is not text", async () => {
    const t = setup();
    await hideComment(t.deps, ID, "x".repeat(900));
    expect((t.log.mock.calls[0] as unknown as [{ reason: string }])[0].reason).toHaveLength(500);
    await hideComment(t.deps, ID, { evil: true });
    expect((t.log.mock.calls[1] as unknown as [{ reason: null }])[0].reason).toBeNull();
  });

  it("a non-admin gets 'Not authorised.' and nothing is read, written or logged", async () => {
    const t = setup({ adminEmail: async () => null });
    expect(await hideComment(t.deps, ID)).toEqual({ ok: false, error: "Not authorised." });
    expect(await unhideComment(t.deps, ID)).toEqual({ ok: false, error: "Not authorised." });
    expect(t.set).not.toHaveBeenCalled();
    expect(t.log).not.toHaveBeenCalled();
  });

  it("refuses an id that is not an id, and a comment that does not exist, without logging", async () => {
    const t = setup({ setStatus: async () => null });
    expect(await hideComment(t.deps, "1; drop table article_comments")).toEqual({ ok: false, error: "That comment no longer exists." });
    expect(t.set).not.toHaveBeenCalled();
    expect(await hideComment(t.deps, ID)).toEqual({ ok: false, error: "That comment no longer exists." });
    expect(t.log).not.toHaveBeenCalled();
  });

  it("reports a database failure, and a log failure as a warning on a change that was made", async () => {
    expect(await hideComment(setup({ setStatus: async () => { throw new Error("db down"); } }).deps, ID)).toEqual({ ok: false, error: "Update failed: db down" });
    const r = await hideComment(setup({ log: async () => { throw new Error("log down"); } }).deps, ID);
    expect(r).toMatchObject({ ok: true, warning: expect.stringContaining("audit log entry failed") });
  });
});