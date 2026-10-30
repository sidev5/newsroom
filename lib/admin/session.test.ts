import { beforeEach, describe, expect, it, vi } from "vitest";

// Supabase Auth is mocked: getUser() returns whatever the test sets. The activity cookie is whatever the test puts in `jar`.
const auth = vi.hoisted(() => ({ getUser: vi.fn() }));
const jar = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => ({ auth }) }));
const net = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "nr_admin_activity" && jar.value ? { name, value: jar.value } : undefined) }),
  headers: async () => net.headers,
}));

import { resetEnvCache } from "@/lib/env";
import { signMarker } from "./activity";
import { currentAdminEmail, currentUserEmail } from "./session";

const SECRET = "test-secret-0123456789";
const MIN = 60_000;
const HOUR = 3_600_000;

const signedIn = (email: string | null) => auth.getUser.mockResolvedValue({ data: { user: email ? { email } : null } });
const marker = async (start: number, last: number) => (jar.value = await signMarker(SECRET, { start, last }));

beforeEach(() => {
  for (const k of ["ADMIN_IDLE_MINUTES", "ADMIN_SESSION_HOURS", "ADMIN_SESSION_SECRET", "NEWSROOM_SELF_HOST_TOKEN", "NEWSROOM_SELF_HOST_ADMIN"]) delete process.env[k];
  net.headers = new Headers();
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    CRON_SECRET: SECRET,
    ADMIN_EMAILS: "Editor@Example.com, admin@example.com",
  });
  resetEnvCache();
  auth.getUser.mockReset();
  jar.value = undefined;
  vi.useRealTimers();
});

describe("currentAdminEmail (used by the admin layout, every admin page and every action)", () => {
  it("returns the email for a signed-in admin with a current session, matching ADMIN_EMAILS case-insensitively", async () => {
    await marker(Date.now(), Date.now());
    signedIn("editor@example.com");
    expect(await currentAdminEmail()).toBe("editor@example.com");
    signedIn("ADMIN@example.com");
    expect(await currentAdminEmail()).toBe("ADMIN@example.com");
  });

  it("rejects a signed-in user who is not on ADMIN_EMAILS", async () => {
    await marker(Date.now(), Date.now());
    signedIn("eve@example.com");
    expect(await currentAdminEmail()).toBeNull();
    expect(await currentUserEmail()).toBe("eve@example.com"); // logged in, but not an admin
  });

  it("rejects a visitor who is not signed in", async () => {
    signedIn(null);
    expect(await currentAdminEmail()).toBeNull();
    expect(await currentUserEmail()).toBeNull();
  });

  it("rejects everyone when ADMIN_EMAILS is empty", async () => {
    await marker(Date.now(), Date.now());
    process.env.ADMIN_EMAILS = "";
    resetEnvCache();
    signedIn("editor@example.com");
    expect(await currentAdminEmail()).toBeNull();
  });

  it("self-hosted with the localhost policy: rejects a valid admin session used from another machine", async () => {
    await marker(Date.now(), Date.now());
    signedIn("editor@example.com");
    process.env.NEWSROOM_SELF_HOST_TOKEN = "t".repeat(64);
    net.headers = new Headers({ "x-newsroom-client": `${"t".repeat(64)} 10.0.0.5`, "x-forwarded-for": "127.0.0.1" });
    expect(await currentAdminEmail()).toBeNull();
    net.headers = new Headers({ "x-newsroom-client": `${"t".repeat(64)} 127.0.0.1` });
    expect(await currentAdminEmail()).toBe("editor@example.com");
  });

  it("rejects a lookalike address", async () => {
    await marker(Date.now(), Date.now());
    signedIn("editor@example.com.evil.test");
    expect(await currentAdminEmail()).toBeNull();
  });
});

describe("admin session limits inside currentAdminEmail (ADM-02)", () => {
  it("rejects an admin with a valid Supabase session but no activity marker", async () => {
    signedIn("editor@example.com");
    expect(await currentAdminEmail()).toBeNull();
  });

  it("rejects a forged or damaged marker", async () => {
    signedIn("editor@example.com");
    jar.value = `${Date.now()}.${Date.now()}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    expect(await currentAdminEmail()).toBeNull();
    jar.value = await signMarker("another-secret-of-length-16+", { start: Date.now(), last: Date.now() });
    expect(await currentAdminEmail()).toBeNull();
  });

  it("rejects after 30 minutes without activity (the default) and accepts just inside it", async () => {
    signedIn("editor@example.com");
    const now = Date.now();
    await marker(now - HOUR, now - 29 * MIN);
    expect(await currentAdminEmail()).toBe("editor@example.com");
    await marker(now - HOUR, now - 31 * MIN);
    expect(await currentAdminEmail()).toBeNull();
  });

  it("rejects 8 hours after signing in, however recent the last request", async () => {
    signedIn("editor@example.com");
    const now = Date.now();
    await marker(now - 7 * HOUR, now - MIN);
    expect(await currentAdminEmail()).toBe("editor@example.com");
    await marker(now - 8 * HOUR - MIN, now - MIN);
    expect(await currentAdminEmail()).toBeNull();
  });

  it("follows ADMIN_IDLE_MINUTES and ADMIN_SESSION_HOURS", async () => {
    signedIn("editor@example.com");
    process.env.ADMIN_IDLE_MINUTES = "5";
    process.env.ADMIN_SESSION_HOURS = "1";
    const now = Date.now();
    await marker(now - 30 * MIN, now - 6 * MIN);
    expect(await currentAdminEmail()).toBeNull();
    await marker(now - 30 * MIN, now - 4 * MIN);
    expect(await currentAdminEmail()).toBe("editor@example.com");
    await marker(now - 61 * MIN, now - MIN);
    expect(await currentAdminEmail()).toBeNull();
  });

  it("does not need the marker for currentUserEmail (that only tells logged-in from logged-out)", async () => {
    signedIn("editor@example.com");
    expect(await currentUserEmail()).toBe("editor@example.com");
  });

  it("uses ADMIN_SESSION_SECRET for the signature when it is set", async () => {
    process.env.ADMIN_SESSION_SECRET = "dedicated-session-secret-1234";
    signedIn("editor@example.com");
    jar.value = await signMarker(SECRET, { start: Date.now(), last: Date.now() }); // signed with the old (cron) secret
    expect(await currentAdminEmail()).toBeNull();
    jar.value = await signMarker("dedicated-session-secret-1234", { start: Date.now(), last: Date.now() });
    expect(await currentAdminEmail()).toBe("editor@example.com");
  });
});
