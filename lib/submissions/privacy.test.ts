import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { PRIVACY_RETENTION } from "@/lib/config";
import { schema } from "@/lib/env-schema";
import { privacyNotice } from "./privacy-notice";
import { TURNSTILE_FIELD, TURNSTILE_VERIFY_URL, turnstileConfig, verifyTurnstile } from "./turnstile";

// SEC-13: the notice on /submit. Optional Turnstile.

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const all = (n: ReturnType<typeof privacyNotice>) => n.items.map((i) => `${i.title}. ${i.text}`).join("\n");
const notice = (over: Partial<Parameters<typeof privacyNotice>[0]> = {}) => privacyNotice({ contact: "privacy@adorpower.com", ipDays: 7, emailDays: 90, ...over });

describe("the privacy notice", () => {
  it("says what is stored: name, department, company email, photo and a hashed IP", () => {
    const text = all(notice());
    for (const part of [/first and last name/i, /department/i, /company email/i, /photo/i, /one-way code/i, /network \(IP\) address/i]) expect(text).toMatch(part);
    expect(text).toMatch(/address itself is never stored/i);
  });

  it("says who sees it: name and department are public as the byline, the email only admins", () => {
    const who = notice().items.find((i) => i.title === "Who can see it")!.text;
    expect(who).toMatch(/name and department appear as its byline/i);
    expect(who).toMatch(/email address is visible only to the newsroom's administrators/i);
    expect(who).toMatch(/network code is not shown to anyone/i);
  });

  it("says how long: the figures are the ones the cleanup job uses", () => {
    const how = notice({ ipDays: 7, emailDays: 90 }).items.find((i) => i.title === "How long we keep it")!.text;
    expect(how).toContain("deleted after 7 days");
    expect(how).toContain("90 days after the editor publishes or rejects");
    expect(how).toMatch(/private copy of your images is deleted/i);
    // a changed setting changes the notice
    expect(notice({ ipDays: 3, emailDays: 30 }).items.find((i) => i.title === "How long we keep it")!.text).toContain("deleted after 3 days");
    expect(notice({ ipDays: 1, emailDays: 1 }).items.find((i) => i.title === "How long we keep it")!.text).toContain("after 1 day.");
    expect([PRIVACY_RETENTION.IP_HASH_DAYS, PRIVACY_RETENTION.EMAIL_DAYS]).toEqual([7, 90]);
  });

  it("gives the contact address from PRIVACY_CONTACT for a deletion request, and a fallback without it", () => {
    const n = notice();
    expect(n.contact).toBe("privacy@adorpower.com");
    expect(n.items.find((i) => i.title === "Asking us to delete it")!.text).toContain("write to privacy@adorpower.com");
    const none = notice({ contact: null });
    expect(none.contact).toBeNull();
    expect(none.items.find((i) => i.title === "Asking us to delete it")!.text).toMatch(/ask the newsroom editor/);
  });

  it("is short: four plain items", () => {
    const n = notice();
    expect(n.items.map((i) => i.title)).toEqual(["What we store", "Who can see it", "How long we keep it", "Asking us to delete it"]);
    expect(all(n).split(/\s+/).length).toBeLessThan(260);
  });

  it("is on the /submit page, fed by the same settings as the cleanup", () => {
    const page = read("app/submit/page.tsx");
    expect(page).toContain("<PrivacyNotice");
    expect(page).toContain("PRIVACY_CONTACT");
    expect(page).toContain("SUBMITTER_IP_RETENTION_DAYS");
    expect(page).toContain("SUBMITTER_EMAIL_RETENTION_DAYS");
  });
});

describe("the privacy settings", () => {
  const parse = (extra: Record<string, string>) =>
    schema.parse({ NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "a", SUPABASE_SERVICE_ROLE_KEY: "s", CRON_SECRET: "0123456789abcdef", ...extra });

  it("default to 7 and 90 days, with no contact", () => {
    const e = parse({});
    expect(e).toMatchObject({ SUBMITTER_IP_RETENTION_DAYS: 7, SUBMITTER_EMAIL_RETENTION_DAYS: 90 });
    expect(e.PRIVACY_CONTACT).toBeUndefined();
  });

  it("can be configured; an empty value means the default; nonsense is refused", () => {
    expect(parse({ SUBMITTER_EMAIL_RETENTION_DAYS: "30", SUBMITTER_IP_RETENTION_DAYS: "2", PRIVACY_CONTACT: "privacy@adorpower.com" })).toMatchObject({
      SUBMITTER_EMAIL_RETENTION_DAYS: 30,
      SUBMITTER_IP_RETENTION_DAYS: 2,
      PRIVACY_CONTACT: "privacy@adorpower.com",
    });
    expect(parse({ SUBMITTER_EMAIL_RETENTION_DAYS: "" }).SUBMITTER_EMAIL_RETENTION_DAYS).toBe(90);
    for (const bad of <Record<string, string>[]>[{ SUBMITTER_EMAIL_RETENTION_DAYS: "0" }, { SUBMITTER_IP_RETENTION_DAYS: "-1" }, { SUBMITTER_IP_RETENTION_DAYS: "abc" }, { PRIVACY_CONTACT: "not an email" }]) {
      expect(() => parse(bad)).toThrow();
    }
  });
});

describe("Turnstile", () => {
  const ok = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it("is off unless both keys are set", () => {
    expect(turnstileConfig({})).toBeNull();
    expect(turnstileConfig({ TURNSTILE_SITE_KEY: "site" })).toBeNull();
    expect(turnstileConfig({ TURNSTILE_SECRET: "secret" })).toBeNull();
    expect(turnstileConfig({ TURNSTILE_SITE_KEY: " ", TURNSTILE_SECRET: "secret" })).toBeNull();
    expect(turnstileConfig({ TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET: "secret" })).toEqual({ siteKey: "site", secret: "secret" });
  });

  it("asks Cloudflare with the secret, the token and the visitor's address", async () => {
    const fetchImpl = ok({ success: true });
    expect(await verifyTurnstile({ secret: "s3cret", token: "tok", ip: "203.0.113.7", fetchImpl: fetchImpl as never })).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(TURNSTILE_VERIFY_URL);
    expect(init.method).toBe("POST");
    const body = init.body as URLSearchParams;
    expect(Object.fromEntries(body)).toEqual({ secret: "s3cret", response: "tok", remoteip: "203.0.113.7" });
  });

  it("leaves out the address when it is unknown", async () => {
    const fetchImpl = ok({ success: true });
    await verifyTurnstile({ secret: "s", token: "t", ip: null, fetchImpl: fetchImpl as never });
    expect(Object.fromEntries((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as URLSearchParams)).toEqual({ secret: "s", response: "t" });
  });

  it("fails closed: no token, a refusal, an error status, a bad answer or an unreachable Cloudflare all mean not verified", async () => {
    const never = vi.fn();
    expect(await verifyTurnstile({ secret: "s", token: "", ip: null, fetchImpl: never as never })).toBe(false);
    expect(await verifyTurnstile({ secret: "s", token: null, ip: null, fetchImpl: never as never })).toBe(false);
    expect(await verifyTurnstile({ secret: "s", token: "x".repeat(3000), ip: null, fetchImpl: never as never })).toBe(false);
    expect(never).not.toHaveBeenCalled(); // no request for a token that cannot be real
    expect(await verifyTurnstile({ secret: "s", token: "t", ip: null, fetchImpl: ok({ success: false, "error-codes": ["invalid-input-response"] }) as never })).toBe(false);
    expect(await verifyTurnstile({ secret: "s", token: "t", ip: null, fetchImpl: ok({ success: true }, 500) as never })).toBe(false);
    expect(await verifyTurnstile({ secret: "s", token: "t", ip: null, fetchImpl: ok({ nope: 1 }) as never })).toBe(false);
    expect(await verifyTurnstile({ secret: "s", token: "t", ip: null, fetchImpl: vi.fn(async () => Promise.reject(new Error("network"))) as never })).toBe(false);
  });

  it("the form field is the one Cloudflare's widget adds, and the action reads it", () => {
    expect(TURNSTILE_FIELD).toBe("cf-turnstile-response");
    expect(read("lib/stories/request.ts")).toContain("TURNSTILE_FIELD");
    expect(read("components/write/WriteForm.tsx")).toMatch(/turnstileSiteKey &&/); // the widget only when a site key is set
  });
});
