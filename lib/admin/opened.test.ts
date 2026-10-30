import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { removeRecipient, REMOVE_NEEDS_CONFIRMATION, type RecipientDeps } from "@/lib/digest/recipients";
import { errorCodeFor } from "./messages";
import { SEEN_MS, SEEN_RATIO, unopenedIds, unopenedWarning } from "./opened";

// SEC-08 (warning on a bulk approve of stories nobody opened) and ADM-05 (confirm before removing a recipient).

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("unopenedIds", () => {
  it("lists the selected stories that were never opened, in selection order", () => {
    expect(unopenedIds(["a", "b", "c", "d"], new Set(["b", "d"]))).toEqual(["a", "c"]);
  });

  it("is empty when everything selected was opened, or nothing is selected", () => {
    expect(unopenedIds(["a", "b"], new Set(["a", "b", "z"]))).toEqual([]);
    expect(unopenedIds([], new Set())).toEqual([]);
  });

  it("is everything when nothing was opened", () => {
    expect(unopenedIds(["a", "b"], new Set())).toEqual(["a", "b"]);
  });

  it("an opened story that is not selected does not matter", () => {
    expect(unopenedIds(["a"], new Set(["x", "y"]))).toEqual(["a"]);
  });
});

describe("unopenedWarning", () => {
  it("is null when every selected story was opened, or nothing is selected", () => {
    expect(unopenedWarning(5, 0)).toBeNull();
    expect(unopenedWarning(0, 0)).toBeNull();
    expect(unopenedWarning(0, 3)).toBeNull();
  });

  it("says how many of the selected stories were never opened, and what approving means", () => {
    const w = unopenedWarning(5, 3)!;
    expect(w).toContain("3 of the 5 selected stories were never opened");
    expect(w).toMatch(/Approving publishes them exactly as stored, without anyone having read them/);
  });

  it("uses the right words for one and for all", () => {
    expect(unopenedWarning(1, 1)).toMatch(/^The selected story was never opened/);
    expect(unopenedWarning(1, 1)).toMatch(/publishes it exactly as stored/);
    expect(unopenedWarning(4, 4)).toMatch(/^All 4 selected stories were never opened/);
    expect(unopenedWarning(4, 1)).toMatch(/^1 of the 4 selected stories was never opened/);
  });

  it("an 'opened' story needs half of it on screen for two seconds (or an interaction)", () => {
    expect(SEEN_MS).toBe(2000);
    expect(SEEN_RATIO).toBe(0.5);
  });
});

describe("the pending board", () => {
  const board = read("app/admin/(protected)/review/PendingBoard.tsx");

  it("warns before a bulk approve and makes the editor tick a box when stories were never opened", () => {
    expect(board).toContain("unopenedWarning(ids.length, unopened.length)");
    expect(board).toMatch(/I understand and want to publish/);
    expect(board).toMatch(/disabled=\{Boolean\(warning\) && !acknowledged\}/);
  });

  it("warns for approving only, not for rejecting", () => {
    expect(board).toMatch(/confirm === "approve" \? unopenedWarning/);
  });

  it("counts a click or focus in a card, but not the select box, and a card seen for a while", () => {
    expect(board).toContain("onClickCapture");
    expect(board).toContain("onFocusCapture");
    expect(board).toContain('closest("[data-select]")');
    expect(board).toMatch(/<input type="checkbox" data-select/);
    expect(board).toContain("IntersectionObserver");
    expect(board).toContain("SEEN_MS");
  });

  it("can take the editor to the first unopened card", () => {
    expect(board).toContain("card-${unopened[0]}");
    expect(board).toContain("id={`card-${a.id}`}");
  });

  it("the server action still demands its own confirmation", () => {
    expect(read("app/admin/(protected)/actions.ts")).toMatch(/if \(!confirmed\(form\)\) back\(form, bannerParams\(\{ error: "needs_confirmation" \}\)\);\n  bulkDone\(form, await bulkApprove/);
  });
});

describe("removing a digest recipient needs a confirmation (ADM-05)", () => {
  function deps(admin: string | null) {
    const removed: string[] = [];
    const logged: unknown[] = [];
    const d: RecipientDeps = {
      adminEmail: async () => admin,
      recipients: { list: async () => [], add: async () => 0, setActive: async () => true, remove: async (id) => (removed.push(id), true) },
      log: async (...args) => void logged.push(args),
    };
    return { d, removed, logged };
  }

  it("without the confirmation nothing is removed or logged", async () => {
    const t = deps("editor@example.com");
    expect(await removeRecipient(t.d, "r1", false)).toEqual({ ok: false, error: REMOVE_NEEDS_CONFIRMATION });
    expect(t.removed).toEqual([]);
    expect(t.logged).toEqual([]);
  });

  it("with it the recipient is removed and the count logged", async () => {
    const t = deps("editor@example.com");
    expect(await removeRecipient(t.d, "r1", true)).toEqual({ ok: true });
    expect(t.removed).toEqual(["r1"]);
    expect(t.logged).toHaveLength(1);
  });

  it("the admin check still comes first: a non-admin without confirmation gets 'Not authorised.'", async () => {
    const t = deps(null);
    expect(await removeRecipient(t.d, "r1", false)).toEqual({ ok: false, error: "Not authorised." });
    expect(await removeRecipient(t.d, "r1", true)).toEqual({ ok: false, error: "Not authorised." });
    expect(t.removed).toEqual([]);
  });

  it("existing callers that do not pass the flag keep working", async () => {
    const t = deps("editor@example.com");
    expect(await removeRecipient(t.d, "r1")).toEqual({ ok: true });
  });

  it("the refusal has its own fixed wording in the URL codes", () => {
    expect(errorCodeFor(REMOVE_NEEDS_CONFIRMATION, () => {})).toBe("digest_remove_needs_confirmation");
  });

  it("the page uses a dialog that posts confirm=yes, outside the other form", () => {
    const dialog = read("app/admin/(protected)/digest/RemoveRecipient.tsx");
    expect(dialog).toContain("<dialog");
    expect(dialog).toContain('name="confirm" value="yes"');
    expect(dialog).toMatch(/cannot be undone/);
    const page = read("app/admin/(protected)/digest/page.tsx");
    expect(page).toContain("<RemoveRecipient");
    expect(page).not.toMatch(/formAction=\{removeRecipientAction\}/);
  });

  it("the action passes the confirmation on", () => {
    expect(read("app/admin/(protected)/digest/actions.ts")).toContain('removeRecipient(recipientDeps(), field(form, "id"), field(form, "confirm") === "yes")');
  });
});
