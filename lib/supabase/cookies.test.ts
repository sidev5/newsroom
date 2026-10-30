import { describe, expect, it } from "vitest";
import { hardenCookies, isHttps, sessionCookieOptions } from "./cookies";

const FOUR_HUNDRED_DAYS = 400 * 24 * 60 * 60;

describe("session cookie hardening (ADM-02)", () => {
  const settings = { secure: true, maxAgeSeconds: 8 * 3600 };

  it("caps the 400-day lifetime the library sets and makes the cookie HttpOnly, SameSite=Lax and Secure", () => {
    const [c] = hardenCookies([{ name: "sb-x-auth-token", value: "v", options: { maxAge: FOUR_HUNDRED_DAYS, sameSite: "none", httpOnly: false, secure: false } }], settings);
    expect(c.options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 8 * 3600 });
  });

  it("uses the cap when the library gives no lifetime, and never lengthens a shorter one", () => {
    expect(hardenCookies([{ name: "a", value: "v" }], settings)[0].options?.maxAge).toBe(8 * 3600);
    expect(hardenCookies([{ name: "a", value: "v", options: { maxAge: 600 } }], settings)[0].options?.maxAge).toBe(600);
  });

  it("keeps a deletion a deletion", () => {
    for (const options of [{ maxAge: 0 }, { maxAge: -1 }]) {
      expect(hardenCookies([{ name: "a", value: "", options }], settings)[0].options?.maxAge).toBe(0);
    }
    expect(hardenCookies([{ name: "a", value: "" }], settings)[0].options?.maxAge).toBe(0);
  });

  it("is not Secure over plain http (local development), so the cookie still works there", () => {
    expect(hardenCookies([{ name: "a", value: "v" }], { ...settings, secure: false })[0].options?.secure).toBe(false);
  });

  it("passes the strict attributes to the client as cookieOptions", () => {
    expect(sessionCookieOptions(true)).toEqual({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
  });
});

describe("isHttps", () => {
  it("follows the forwarded protocol, then the environment", () => {
    expect(isHttps("https")).toBe(true);
    expect(isHttps("https:")).toBe(true);
    expect(isHttps("http")).toBe(false);
    expect(isHttps("https, http")).toBe(true); // first hop wins
    expect(isHttps(null, "production")).toBe(true);
    expect(isHttps(undefined, "development")).toBe(false);
  });
});
