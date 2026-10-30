import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  articleParam,
  AUDIT_WARNING,
  bannerFromSearch,
  bannerParams,
  ERROR_TEXT,
  errorCodeFor,
  EXPIRED_MESSAGE,
  isNotAuthorised,
  LOGIN_EXPIRED_PATH,
  NOT_AUTHORISED,
} from "./messages";
import { EMPLOYEE_REASON_REQUIRED } from "./review";

describe("expired sessions", () => {
  it("recognise the one message every admin function returns, and nothing else", () => {
    expect(NOT_AUTHORISED).toBe("Not authorised.");
    expect(isNotAuthorised("Not authorised.")).toBe(true);
    expect(isNotAuthorised("not authorised")).toBe(false);
    expect(isNotAuthorised("Not authorised. Please log in")).toBe(false);
    expect(isNotAuthorised(undefined)).toBe(false);
    expect(LOGIN_EXPIRED_PATH).toBe("/admin/login?reason=expired");
    expect(EXPIRED_MESSAGE).toBe("You were signed out after a period of inactivity. Please sign in again.");
  });
});

describe("errorCodeFor: the messages the admin functions return map to fixed codes", () => {
  const quiet = () => {};
  it.each([
    ["This article is no longer pending review.", "not_pending"],
    ["This article is no longer published.", "not_published"],
    ["This article is no longer rejected.", "not_rejected"],
    ["This item is no longer skipped or failed.", "not_skipped"],
    [EMPLOYEE_REASON_REQUIRED, "employee_reason"],
    ["The story was not published because its photo could not be moved to the public bucket: storage is down", "photo_move"],
    ["Headline is required", "invalid_edit"],
    ["Body is too long", "invalid_edit"],
    ["Nothing selected.", "nothing_selected"],
    ["Select at most 50 articles at a time.", "too_many"],
    ["Update failed: duplicate key value violates unique constraint", "update_failed"],
    ["Loading failed: timeout", "load_failed"],
    ["Unknown department.", "unknown_department"],
    ["Pick a department: this item has none.", "pick_department"],
    ["Digest not found.", "digest_not_found"],
    ["A digest that is sent cannot be edited.", "digest_not_editable"],
    ["This digest can no longer be edited: it is being sent or has been sent.", "digest_not_editable"],
    ["Only a draft can be approved (this one is sent).", "digest_not_draft"],
    ["Add at least one recipient (or set DIGEST_TO) before approving.", "digest_no_recipients"],
    ["There are no recipients.", "digest_no_recipients"],
    ["This digest has already been sent.", "digest_already_sent"],
    ["This digest is already being sent, or is no longer approved.", "digest_already_sending"],
    ["Sending needs confirmation.", "digest_sending_needs_confirmation"],
    ["SMTP AUTH is disabled for this mailbox; ask IT to enable it, or use Download .eml", "smtp_auth"],
    ["Email sending is switched off (EMAIL_PROVIDER=none). Use Download .eml, or set EMAIL_PROVIDER to smtp or graph.", "mail_disabled"],
    ["535 failed (EAUTH) 2 of 3 batches had already been sent; check before sending again.", "send_failed"],
    ["None of those look like email addresses.", "recipients_none_valid"],
    ["Add at most 500 addresses at a time.", "recipients_too_many"],
    ["That recipient no longer exists.", "recipient_gone"],
  ])("%s -> %s", (message, code) => {
    expect(errorCodeFor(message, quiet)).toBe(code);
  });

  it("gives every code a fixed text without markup or addresses", () => {
    for (const [code, text] of Object.entries(ERROR_TEXT)) {
      expect(text, code).not.toMatch(/[<>]|@/);
      expect(text.length, code).toBeGreaterThan(10);
    }
  });

  it("turns anything unknown into 'generic' and logs the original instead of showing it", () => {
    const log = vi.fn();
    expect(errorCodeFor("relation \"public.articles\" does not exist (secret detail)", log)).toBe("generic");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("secret detail"));
    expect(errorCodeFor("", log)).toBe("generic");
    expect(errorCodeFor(undefined, log)).toBe("generic");
  });
});

describe("no admin page renders free text from the URL (SEC-09)", () => {
  const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

  it("the pages show only what bannerFromSearch returns", () => {
    for (const page of ["app/admin/(protected)/review/page.tsx", "app/admin/(protected)/digest/page.tsx"]) {
      const text = read(page);
      expect(text, page).toContain("bannerFromSearch(");
      expect(text, page).not.toMatch(/\{(notice|error|sp\.notice|sp\.error)\}/);
      expect(text, page).not.toMatch(/const \{[^}]*\b(notice|error)\b[^}]*\} = (sp|await searchParams)/);
    }
  });

  it("the actions redirect with codes: no message text is passed to the redirect helpers", () => {
    for (const file of ["app/admin/(protected)/actions.ts", "app/admin/(protected)/digest/actions.ts"]) {
      const text = read(file);
      // The error message itself is never passed on to the URL: no back(...) or redirect(...) line mentions `.error`.
      const lines = text.split("\n").filter((l) => /\b(back|redirect)\(/.test(l) && !/^\s*(export )?(async )?function /.test(l));
      expect(lines.length, file).toBeGreaterThan(5);
      for (const line of lines) expect(line, file).not.toContain(".error");
      expect(text, file).not.toMatch(/URLSearchParams\(\{\s*(error|notice)/);
    }
  });
});

describe("banners from the URL (SEC-09)", () => {
  it("round-trip a code and small counts through the query string", () => {
    const params = bannerParams({ notice: "bulk_published", n: 3, k: 2, why: "not_pending", warn: true });
    expect(params).toEqual({ notice: "bulk_published", n: "3", k: "2", why: "not_pending", warn: "1" });
    expect(bannerFromSearch(params)).toEqual({
      kind: "problem",
      text: `Published 3 articles. 2 skipped: ${ERROR_TEXT.not_pending} ${AUDIT_WARNING}`,
    });
  });

  it("show an ordinary success as a notice and a failure as a problem", () => {
    expect(bannerFromSearch({ notice: "published" })).toEqual({ kind: "ok", text: "Published." });
    expect(bannerFromSearch({ error: "not_pending" })).toEqual({ kind: "problem", text: ERROR_TEXT.not_pending });
    expect(bannerFromSearch({ notice: "digest_created", n: "1" })).toEqual({ kind: "ok", text: "Draft created with 1 story." });
    expect(bannerFromSearch({ notice: "recipients_added", n: "5", k: "2", m: "1" })).toEqual({
      kind: "ok",
      text: "Added 5. 2 already on the list. 1 did not look like an address and was skipped.",
    });
    expect(bannerFromSearch({ notice: "digest_sent", n: "12", k: "1" })).toEqual({ kind: "ok", text: "Sent to 12 recipients in 1 message." });
  });

  it("never show text from the URL: a crafted message or markup is ignored", () => {
    for (const sp of [
      { error: "Your account is locked. Call 555-0100 to unlock it." },
      { notice: "<script>alert(1)</script>" },
      { error: "<b>Click here</b>" },
      { notice: "toString" },
      { error: "__proto__" },
      { error: "constructor" },
      { notice: ["published", "rejected"] },
      { notice: "" },
      {},
    ]) {
      expect(bannerFromSearch(sp as never), JSON.stringify(sp)).toBeNull();
    }
  });

  it("ignore counts that are not small whole numbers, and unknown 'why' codes", () => {
    expect(bannerFromSearch({ notice: "bulk_rejected", n: "<img>", k: "99999", why: "Call me" })).toEqual({ kind: "ok", text: "Rejected 0 articles." });
    expect(bannerFromSearch({ notice: "bulk_rejected", n: "2", k: "1", why: "Call me" })).toEqual({ kind: "problem", text: "Rejected 2 articles. 1 skipped." });
  });

  it("only put codes and numbers into a redirect", () => {
    const params = bannerParams({ error: "generic", n: Number.NaN, k: -3, m: 1e9 });
    expect(params).toEqual({ error: "generic", m: "9999" });
  });

  it("accept an article id only if it is a UUID (it only highlights a card)", () => {
    expect(articleParam("0b6f9a6e-2f4d-4d7e-9a53-3c1f0e8b7a11")).toBe("0b6f9a6e-2f4d-4d7e-9a53-3c1f0e8b7a11");
    expect(articleParam("<script>")).toBeNull();
    expect(articleParam(["x"])).toBeNull();
    expect(articleParam(undefined)).toBeNull();
  });
});
