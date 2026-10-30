import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The Supabase server client is replaced by a fake that reports a user (or none) and records signOut.
const fake = vi.hoisted(() => ({
  user: null as { email: string } | null,
  signOut: vi.fn(async () => {}),
  setAllOnGetUser: null as null | { name: string; value: string; options: Record<string, unknown> }[],
  captured: null as null | { cookieOptions?: Record<string, unknown> },
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: string, _key: string, opts: { cookieOptions?: Record<string, unknown>; cookies: { setAll: (c: unknown[]) => void } }) => {
    fake.captured = opts;
    return {
      auth: {
        getUser: async () => {
          // a refreshed session: the library asks the proxy to set the auth cookie with its own (400-day) options
          if (fake.setAllOnGetUser) opts.cookies.setAll(fake.setAllOnGetUser);
          return { data: { user: fake.user } };
        },
        signOut: fake.signOut,
      },
    };
  },
}));

import { signMarker } from "@/lib/admin/activity";
import { proxy } from "./proxy";

const SECRET = "test-secret-0123456789";
const MIN = 60_000;
const HOUR = 3_600_000;
const FOUR_HUNDRED_DAYS = 400 * 24 * 3600;

beforeEach(() => {
  for (const k of ["ADMIN_IDLE_MINUTES", "ADMIN_SESSION_HOURS", "ADMIN_SESSION_SECRET"]) delete process.env[k];
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon", CRON_SECRET: SECRET });
  fake.user = null;
  fake.signOut.mockClear();
  fake.setAllOnGetUser = null;
  fake.captured = null;
});

function request(path: string, cookies: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  return new NextRequest(`http://localhost:3000${path}`, { headers: { ...(cookie ? { cookie } : {}), ...headers } });
}

const marker = (start: number, last: number) => signMarker(SECRET, { start, last });
const setCookie = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));

describe("proxy: signed-out visitors", () => {
  it("sends a visitor without a session to the login page", async () => {
    const res = await proxy(request("/admin/review"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/admin/login");
  });

  it("lets the login page itself through", async () => {
    const res = await proxy(request("/admin/login"));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("proxy: self-hosted on a LAN (docs/SELF_HOST.md)", () => {
  const TOKEN = "t".repeat(64);
  const client = (address: string) => ({ "x-newsroom-client": `${TOKEN} ${address}` });

  it("with the localhost policy, answers 404 to other machines, even with a forged X-Forwarded-For", async () => {
    process.env.NEWSROOM_SELF_HOST_TOKEN = TOKEN;
    try {
      for (const path of ["/admin/login", "/admin/review"]) {
        const res = await proxy(request(path, {}, { ...client("10.0.0.5"), "x-forwarded-for": "127.0.0.1" }));
        expect(res.status).toBe(404);
      }
      expect((await proxy(request("/admin/login", {}, client("127.0.0.1")))).status).toBe(200);
    } finally {
      delete process.env.NEWSROOM_SELF_HOST_TOKEN;
    }
  });
});

describe("proxy: the idle and absolute session limits (ADM-02)", () => {
  const now = Date.now();

  it("lets a current session through and refreshes the last-activity time", async () => {
    fake.user = { email: "editor@example.com" };
    const start = now - HOUR;
    const res = await proxy(request("/admin/review", { nr_admin_activity: await marker(start, now - 5 * MIN) }));
    expect(res.status).toBe(200);
    const cookie = setCookie(res, "nr_admin_activity")!;
    expect(cookie).toBeDefined();
    const value = decodeURIComponent(cookie.split(";")[0].split("=")[1]);
    const [s, l] = value.split(".").map(Number);
    expect(s).toBe(start); // the sign-in time never moves
    expect(l).toBeGreaterThanOrEqual(now); // the idle window slid forward
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Max-Age=28800/); // the absolute limit
    expect(fake.signOut).not.toHaveBeenCalled();
  });

  it("signs out after 30 minutes of inactivity and goes to the login page with reason=expired", async () => {
    fake.user = { email: "editor@example.com" };
    const res = await proxy(request("/admin/review", { nr_admin_activity: await marker(now - HOUR, now - 31 * MIN), "sb-abc-auth-token": "token", other: "keep" }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/admin/login?reason=expired");
    expect(fake.signOut).toHaveBeenCalledTimes(1);
    // every auth cookie and the marker are cleared
    for (const name of ["sb-abc-auth-token", "nr_admin_activity"]) expect(setCookie(res, name)).toMatch(/Max-Age=0/);
    expect(setCookie(res, "other")).toBeUndefined();
  });

  it("signs out 8 hours after signing in, even when the admin was active a minute ago", async () => {
    fake.user = { email: "editor@example.com" };
    const res = await proxy(request("/admin/costs", { nr_admin_activity: await marker(now - 8 * HOUR - 2 * MIN, now - MIN) }));
    expect(res.headers.get("location")).toBe("http://localhost:3000/admin/login?reason=expired");
    expect(fake.signOut).toHaveBeenCalled();
  });

  it("treats a session with no marker as expired (a stale or pre-existing session must sign in again)", async () => {
    fake.user = { email: "editor@example.com" };
    const res = await proxy(request("/admin/review", { "sb-abc-auth-token": "token" }));
    expect(res.headers.get("location")).toBe("http://localhost:3000/admin/login?reason=expired");
  });

  it("treats a forged marker as expired", async () => {
    fake.user = { email: "editor@example.com" };
    const forged = `${now}.${now}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const res = await proxy(request("/admin/review", { nr_admin_activity: forged }));
    expect(res.headers.get("location")).toBe("http://localhost:3000/admin/login?reason=expired");
  });

  it("refuses every session when there is no usable secret", async () => {
    fake.user = { email: "editor@example.com" };
    process.env.CRON_SECRET = "short";
    const res = await proxy(request("/admin/review", { nr_admin_activity: await marker(now, now) }));
    expect(res.headers.get("location")).toBe("http://localhost:3000/admin/login?reason=expired");
  });

  it("follows ADMIN_IDLE_MINUTES and ADMIN_SESSION_HOURS", async () => {
    fake.user = { email: "editor@example.com" };
    process.env.ADMIN_IDLE_MINUTES = "5";
    process.env.ADMIN_SESSION_HOURS = "1";
    expect((await proxy(request("/admin/review", { nr_admin_activity: await marker(now - 30 * MIN, now - 4 * MIN) }))).status).toBe(200);
    expect((await proxy(request("/admin/review", { nr_admin_activity: await marker(now - 30 * MIN, now - 6 * MIN) }))).status).toBe(307);
    expect((await proxy(request("/admin/review", { nr_admin_activity: await marker(now - 61 * MIN, now - MIN) }))).status).toBe(307);
  });

  it("applies to server actions and every other admin path, not only pages", async () => {
    fake.user = { email: "editor@example.com" };
    const expired = await marker(now - 2 * HOUR, now - 45 * MIN);
    for (const path of ["/admin/review?tab=pending", "/admin/digest", "/admin/digest/eml?id=x", "/admin/security", "/admin"]) {
      const res = await proxy(request(path, { nr_admin_activity: expired }));
      expect(res.headers.get("location"), path).toBe("http://localhost:3000/admin/login?reason=expired");
    }
  });
});

describe("proxy: session cookie attributes (ADM-02)", () => {
  it("clamps the 400-day session cookie from the library to the absolute limit, HttpOnly, SameSite=Lax", async () => {
    fake.user = { email: "editor@example.com" };
    fake.setAllOnGetUser = [{ name: "sb-abc-auth-token", value: "refreshed", options: { maxAge: FOUR_HUNDRED_DAYS, sameSite: "none", httpOnly: false, path: "/" } }];
    const now = Date.now();
    const res = await proxy(request("/admin/review", { nr_admin_activity: await marker(now - HOUR, now - MIN) }));
    const cookie = setCookie(res, "sb-abc-auth-token")!;
    expect(cookie).toMatch(/Max-Age=28800/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).not.toMatch(/Secure/i); // plain http on localhost
  });

  it("is Secure when the request came over https", async () => {
    fake.user = { email: "editor@example.com" };
    fake.setAllOnGetUser = [{ name: "sb-abc-auth-token", value: "refreshed", options: { maxAge: FOUR_HUNDRED_DAYS } }];
    const now = Date.now();
    const res = await proxy(request("/admin/review", { nr_admin_activity: await marker(now - HOUR, now - MIN) }, { "x-forwarded-proto": "https" }));
    expect(setCookie(res, "sb-abc-auth-token")).toMatch(/Secure/i);
    expect(setCookie(res, "nr_admin_activity")).toMatch(/Secure/i);
  });

  it("asks the Supabase client for strict cookies", async () => {
    await proxy(request("/admin/review", {}, { "x-forwarded-proto": "https" }));
    expect(fake.captured?.cookieOptions).toEqual({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
  });
});

describe("proxy: matcher", () => {
  it("only covers admin paths", async () => {
    const { config } = await import("./proxy");
    expect(config.matcher).toEqual(["/admin/:path*"]);
  });
});
