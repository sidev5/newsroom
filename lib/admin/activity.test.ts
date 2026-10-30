import { describe, expect, it } from "vitest";
import {
  adminLimits,
  checkActivity,
  DEFAULT_IDLE_MINUTES,
  DEFAULT_SESSION_HOURS,
  markerCookieOptions,
  markerSecret,
  readMarker,
  signMarker,
} from "./activity";

const SECRET = "a-long-test-secret-value-1234";
const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = 1_760_000_000_000; // an arbitrary "now" in epoch milliseconds
const limits = adminLimits({});

describe("limits from the environment", () => {
  it("default to 30 minutes idle and 8 hours in total", () => {
    expect(DEFAULT_IDLE_MINUTES).toBe(30);
    expect(DEFAULT_SESSION_HOURS).toBe(8);
    expect(adminLimits({})).toEqual({ idleMs: 30 * MIN, absoluteMs: 8 * HOUR });
  });

  it("read ADMIN_IDLE_MINUTES and ADMIN_SESSION_HOURS", () => {
    expect(adminLimits({ ADMIN_IDLE_MINUTES: "15", ADMIN_SESSION_HOURS: "2" })).toEqual({ idleMs: 15 * MIN, absoluteMs: 2 * HOUR });
    expect(adminLimits({ ADMIN_IDLE_MINUTES: "0.5" }).idleMs).toBe(30_000);
  });

  it("never switch a limit off because of a typo: empty, zero, negative or junk fall back to the default", () => {
    for (const bad of ["", " ", "0", "-5", "abc", "NaN", "Infinity"]) {
      expect(adminLimits({ ADMIN_IDLE_MINUTES: bad, ADMIN_SESSION_HOURS: bad })).toEqual({ idleMs: 30 * MIN, absoluteMs: 8 * HOUR });
    }
  });
});

describe("signing secret", () => {
  it("is ADMIN_SESSION_SECRET if set, else CRON_SECRET, and only if long enough", () => {
    expect(markerSecret({ ADMIN_SESSION_SECRET: SECRET, CRON_SECRET: "x".repeat(20) })).toBe(SECRET);
    expect(markerSecret({ CRON_SECRET: "x".repeat(20) })).toBe("x".repeat(20));
    expect(markerSecret({ ADMIN_SESSION_SECRET: "short", CRON_SECRET: "x".repeat(20) })).toBe("x".repeat(20));
    expect(markerSecret({ CRON_SECRET: "short" })).toBeNull();
    expect(markerSecret({})).toBeNull();
  });
});

describe("the activity marker", () => {
  it("round-trips and carries the two times", async () => {
    const value = await signMarker(SECRET, { start: T0, last: T0 + 5 * MIN });
    expect(value).toMatch(/^\d+\.\d+\.[A-Za-z0-9_-]+$/);
    expect(await readMarker(SECRET, value)).toEqual({ start: T0, last: T0 + 5 * MIN });
  });

  it("is refused when it was signed with another secret, or when either time is edited", async () => {
    const value = await signMarker(SECRET, { start: T0, last: T0 + MIN });
    expect(await readMarker("another-long-test-secret-5678", value)).toBeNull();
    const [start, last, sig] = value.split(".");
    expect(await readMarker(SECRET, `${Number(start) + 1000}.${last}.${sig}`)).toBeNull(); // later start
    expect(await readMarker(SECRET, `${start}.${Number(last) + 1000}.${sig}`)).toBeNull(); // extended activity
    expect(await readMarker(SECRET, `${start}.${last}.${sig.slice(0, -2)}AA`)).toBeNull(); // damaged signature
  });

  it("is refused when it is malformed", async () => {
    for (const bad of ["", "abc", "1.2.3", `${T0}.${T0}`, `${T0}.${T0}.`, `${T0}.${T0}.!!!!!!!!!!!!!!!!!!!!!!!`, "x".repeat(200)]) {
      expect(await readMarker(SECRET, bad)).toBeNull();
    }
    expect(await readMarker(SECRET, undefined)).toBeNull();
  });
});

describe("checkActivity", () => {
  const at = async (start: number, last: number, now: number, secret: string | null = SECRET) =>
    checkActivity(secret, await signMarker(SECRET, { start, last }), now, limits);

  it("accepts a session that is recent and young", async () => {
    expect(await at(T0, T0, T0)).toEqual({ ok: true, marker: { start: T0, last: T0 } });
    expect(await at(T0, T0 + 3 * HOUR, T0 + 3 * HOUR + 10 * MIN)).toMatchObject({ ok: true });
  });

  it("signs out after 30 minutes without a request, and not before", async () => {
    expect(await at(T0, T0, T0 + 30 * MIN)).toMatchObject({ ok: true }); // exactly at the limit is still fine
    expect(await at(T0, T0, T0 + 30 * MIN + 1)).toEqual({ ok: false, reason: "idle" });
  });

  it("signs out 8 hours after signing in, even if the admin was active a minute ago", async () => {
    const start = T0;
    expect(await at(start, start + 8 * HOUR - MIN, start + 8 * HOUR)).toMatchObject({ ok: true });
    expect(await at(start, start + 8 * HOUR, start + 8 * HOUR + 1)).toEqual({ ok: false, reason: "absolute" });
    expect(await at(start, start + 8 * HOUR - 5 * MIN, start + 8 * HOUR + 2 * MIN)).toEqual({ ok: false, reason: "absolute" });
  });

  it("honours custom limits", async () => {
    const custom = adminLimits({ ADMIN_IDLE_MINUTES: "5", ADMIN_SESSION_HOURS: "1" });
    const v = await signMarker(SECRET, { start: T0, last: T0 });
    expect(await checkActivity(SECRET, v, T0 + 6 * MIN, custom)).toEqual({ ok: false, reason: "idle" });
    expect((await checkActivity(SECRET, await signMarker(SECRET, { start: T0, last: T0 + 59 * MIN }), T0 + 61 * MIN, custom)).ok).toBe(false);
  });

  it("says missing for no cookie and invalid for a forged, damaged or future-dated one", async () => {
    expect(await checkActivity(SECRET, undefined, T0, limits)).toEqual({ ok: false, reason: "missing" });
    expect(await checkActivity(SECRET, "", T0, limits)).toEqual({ ok: false, reason: "missing" });
    expect(await checkActivity(SECRET, "garbage", T0, limits)).toEqual({ ok: false, reason: "invalid" });
    expect(await at(T0, T0 + 10 * HOUR, T0)).toEqual({ ok: false, reason: "invalid" }); // activity "in the future"
    expect(await at(T0 + HOUR, T0, T0 + 2 * HOUR)).toEqual({ ok: false, reason: "invalid" }); // last before start
  });

  it("refuses everything when there is no secret", async () => {
    const value = await signMarker(SECRET, { start: T0, last: T0 });
    expect(await checkActivity(null, value, T0, limits)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("marker cookie attributes", () => {
  it("is HttpOnly, SameSite=Lax, Secure on https, and expires with the absolute limit", () => {
    expect(markerCookieOptions(true, adminLimits({}))).toEqual({ httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 8 * 3600 });
    expect(markerCookieOptions(false, adminLimits({ ADMIN_SESSION_HOURS: "2" }))).toMatchObject({ secure: false, maxAge: 2 * 3600 });
  });
});
