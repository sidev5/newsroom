import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ItemLink, SourceLinks } from "@/app/admin/(protected)/review/SourceLinks";
import { hasVerifiedFactor, MFA_NOTE, type MfaClient } from "./mfa";

const client = (result: unknown): MfaClient => ({ auth: { mfa: { listFactors: async () => result as never } } });

describe("hasVerifiedFactor (the optional MFA note)", () => {
  it("is true when a verified authenticator app exists", async () => {
    expect(await hasVerifiedFactor(client({ data: { totp: [{ status: "verified" }], all: [] }, error: null }))).toBe(true);
  });

  it("is false when there is none, or only an unfinished enrolment", async () => {
    expect(await hasVerifiedFactor(client({ data: { totp: [], all: [] }, error: null }))).toBe(false);
    expect(await hasVerifiedFactor(client({ data: { totp: [{ status: "unverified" }], all: [{ status: "unverified", factor_type: "totp" }] }, error: null }))).toBe(false);
    expect(await hasVerifiedFactor(client({ data: { all: [{ status: "verified", factor_type: "phone" }] }, error: null }))).toBe(false);
  });

  it("is null (no note, no claim) when Supabase cannot say", async () => {
    expect(await hasVerifiedFactor(client({ data: null, error: { message: "down" } }))).toBeNull();
    expect(await hasVerifiedFactor({ auth: { mfa: { listFactors: async () => Promise.reject(new Error("network")) } } })).toBeNull();
  });

  it("has a note that says it is optional", () => {
    expect(MFA_NOTE).toMatch(/optional/);
  });
});

describe("admin source links (SEC-12)", () => {
  const html = (urls: string[]) => renderToStaticMarkup(createElement(SourceLinks, { urls }));

  it("link only web URLs, with noopener", () => {
    const out = html(["https://example.com/a", "http://example.org/b"]);
    expect(out).toContain('href="https://example.com/a"');
    expect(out).toContain('href="http://example.org/b"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it("drop javascript:, data:, file: and malformed URLs instead of rendering them", () => {
    const out = html(["javascript:alert(1)", "data:text/html,<script>1</script>", "file:///etc/passwd", "not a url", "vbscript:x", " JaVaScRiPt:alert(1)"]);
    expect(out).toBe("");
    expect(out).not.toMatch(/javascript|href/i);
  });

  it("keeps the good links when a bad one is mixed in", () => {
    const out = html(["javascript:alert(1)", "https://example.com/ok"]);
    expect(out.match(/<a /g)).toHaveLength(1);
    expect(out).toContain("https://example.com/ok");
  });

  it("the item title is a link only for a web URL, and plain text otherwise", () => {
    expect(renderToStaticMarkup(createElement(ItemLink, { url: "https://example.com/x" } as never, "Title"))).toContain('<a href="https://example.com/x"');
    const bad = renderToStaticMarkup(createElement(ItemLink, { url: "javascript:alert(1)" } as never, "Title"));
    expect(bad).toBe("Title");
  });
});
