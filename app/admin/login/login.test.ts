import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  signIn: vi.fn(),
  signOut: vi.fn(async () => {}),
  set: vi.fn(),
  proto: null as string | null,
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: m.set }),
  headers: async () => ({ get: (n: string) => (n === "x-forwarded-proto" ? m.proto : null) }),
}));
vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => ({ auth: { signInWithPassword: m.signIn, signOut: m.signOut } }) }));

import { resetEnvCache } from "@/lib/env";
import { checkActivity, adminLimits } from "@/lib/admin/activity";
import { loginAction } from "./actions";
import { LOGIN_EXPIRED_PATH } from "@/lib/admin/messages";

const SECRET = "test-secret-0123456789";
const form = (email: string, password: string) => {
  const f = new FormData();
  f.set("email", email);
  f.set("password", password);
  return f;
};

beforeEach(() => {
  for (const k of ["ADMIN_IDLE_MINUTES", "ADMIN_SESSION_HOURS", "ADMIN_SESSION_SECRET"]) delete process.env[k];
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    CRON_SECRET: SECRET,
    ADMIN_EMAILS: "editor@example.com",
  });
  resetEnvCache();
  m.signIn.mockReset();
  m.signOut.mockClear();
  m.set.mockClear();
  m.proto = null;
});

describe("loginAction (server-side sign-in)", () => {
  it("signs an admin in, starts the activity marker and goes to the review page", async () => {
    m.signIn.mockResolvedValue({ data: { user: { email: "Editor@Example.com" } }, error: null });
    await expect(loginAction(null, form("editor@example.com", "pw"))).rejects.toThrow("REDIRECT /admin/review");
    expect(m.set).toHaveBeenCalledTimes(1);
    const [name, value, options] = m.set.mock.calls[0];
    expect(name).toBe("nr_admin_activity");
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 8 * 3600, secure: false });
    // a fresh session: both times are "now", and the marker is genuine
    expect(await checkActivity(SECRET, value, Date.now(), adminLimits({}))).toMatchObject({ ok: true });
  });

  it("marks the marker cookie Secure behind https", async () => {
    m.proto = "https";
    m.signIn.mockResolvedValue({ data: { user: { email: "editor@example.com" } }, error: null });
    await expect(loginAction(null, form("editor@example.com", "pw"))).rejects.toThrow("REDIRECT");
    expect(m.set.mock.calls[0][2]).toMatchObject({ secure: true });
  });

  it("uses ADMIN_SESSION_HOURS for the cookie lifetime", async () => {
    process.env.ADMIN_SESSION_HOURS = "2";
    m.signIn.mockResolvedValue({ data: { user: { email: "editor@example.com" } }, error: null });
    await expect(loginAction(null, form("editor@example.com", "pw"))).rejects.toThrow("REDIRECT");
    expect(m.set.mock.calls[0][2]).toMatchObject({ maxAge: 2 * 3600 });
  });

  it("refuses a wrong password with a fixed message and sets no cookie", async () => {
    m.signIn.mockResolvedValue({ data: { user: null }, error: { message: "Invalid login credentials (detail from Supabase)" } });
    expect(await loginAction(null, form("editor@example.com", "nope"))).toEqual({ error: "That email and password do not match." });
    expect(m.set).not.toHaveBeenCalled();
  });

  it("signs out and refuses a valid account that is not an admin", async () => {
    m.signIn.mockResolvedValue({ data: { user: { email: "eve@example.com" } }, error: null });
    expect(await loginAction(null, form("eve@example.com", "pw"))).toEqual({ error: "This account is not an administrator." });
    expect(m.signOut).toHaveBeenCalledTimes(1);
    expect(m.set).not.toHaveBeenCalled();
  });

  it("asks for both fields and never calls Supabase without them", async () => {
    expect(await loginAction(null, form("", ""))).toEqual({ error: "Enter your email and password." });
    expect(m.signIn).not.toHaveBeenCalled();
  });

  it("does not sign anyone in when the server has no usable session secret", async () => {
    process.env.CRON_SECRET = "short";
    const r = await loginAction(null, form("editor@example.com", "pw"));
    expect(r?.error).toMatch(/no session secret/);
    expect(m.signIn).not.toHaveBeenCalled();
  });

  it("self-hosted with the localhost policy: refuses sign-in from another machine before asking Supabase", async () => {
    process.env.NEWSROOM_SELF_HOST_TOKEN = "t".repeat(64);
    try {
      expect(await loginAction(null, form("editor@example.com", "pw"))).toEqual({ error: "Sign-in is only available on the server PC." });
      expect(m.signIn).not.toHaveBeenCalled();
    } finally {
      delete process.env.NEWSROOM_SELF_HOST_TOKEN;
    }
  });

  it("the expired-session path is the one the login page explains", () => {
    expect(LOGIN_EXPIRED_PATH).toBe("/admin/login?reason=expired");
  });
});
