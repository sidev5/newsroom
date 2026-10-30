import { beforeEach, describe, expect, it, vi } from "vitest";

// The routes of the reader sign-in, likes and comments: who may call them, how they answer, and the cookie they set. The
// services behind them are tested in lib/reader; here they are replaced by stubs.

const stub = vi.hoisted(() => ({
  requestCode: vi.fn(),
  verifyCode: vi.fn(),
  getEngagement: vi.fn(),
  toggleLike: vi.fn(),
  addComment: vi.fn(),
  available: true,
  session: null as { k: string; n: string; exp: number } | null,
}));

vi.mock("@/lib/reader/auth", () => ({ requestCode: stub.requestCode, verifyCode: stub.verifyCode, SIGN_IN_UNAVAILABLE: "Likes and comments are not switched on for this site yet." }));
vi.mock("@/lib/reader/engagement", () => ({ getEngagement: stub.getEngagement, toggleLike: stub.toggleLike, addComment: stub.addComment }));
vi.mock("@/lib/reader/runtime", () => ({
  authDeps: () => ({}),
  engagementDeps: () => ({}),
  readerSignInAvailable: () => stub.available,
  readerSecret: () => "reader-test-secret-0123456789",
  sessionOf: () => stub.session,
}));

import { POST as codeRoute } from "./code/route";
import { POST as verifyRoute } from "./verify/route";
import { POST as signoutRoute } from "./signout/route";
import { GET as engagementRoute } from "../story/[slug]/engagement/route";
import { POST as likeRoute } from "../story/[slug]/like/route";
import { POST as commentRoute } from "../story/[slug]/comments/route";
import { verifySession } from "@/lib/reader/identity";

const SITE = "https://news.example.com";
const SESSION = { k: "a".repeat(64), n: "Ada", exp: 4_000_000_000 };
const slugCtx = (slug = "story-a") => ({ params: Promise.resolve({ slug }) }) as never;

const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Request(`${SITE}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: SITE, host: "news.example.com", ...headers }, body: JSON.stringify(body) });

beforeEach(() => {
  for (const f of [stub.requestCode, stub.verifyCode, stub.getEngagement, stub.toggleLike, stub.addComment]) f.mockReset();
  stub.available = true;
  stub.session = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const ROUTES: [string, () => Promise<Response>][] = [
  ["code", () => codeRoute(post("/api/reader/code", { email: "a@adorpower.com" }, { origin: "https://evil.example" }))],
  ["verify", () => verifyRoute(post("/api/reader/verify", { email: "a@adorpower.com", code: "123456" }, { origin: "https://evil.example" }))],
  ["signout", () => signoutRoute(post("/api/reader/signout", {}, { origin: "https://evil.example" }))],
  ["like", () => likeRoute(post("/api/story/story-a/like", {}, { origin: "https://evil.example" }), slugCtx())],
  ["comments", () => commentRoute(post("/api/story/story-a/comments", { body: "hello" }, { origin: "https://evil.example" }), slugCtx())],
];

describe("every route that changes something refuses another site", () => {
  it.each(ROUTES)("%s answers 403 for a request from another origin, and does nothing", async (_name, call) => {
    stub.session = SESSION;
    const res = await call();
    expect(res.status).toBe(403);
    for (const f of [stub.requestCode, stub.verifyCode, stub.toggleLike, stub.addComment]) expect(f).not.toHaveBeenCalled();
  });

  it("and one without an Origin (a plain script or form)", async () => {
    const req = new Request(`${SITE}/api/story/story-a/like`, { method: "POST", headers: { "content-type": "application/json", host: "news.example.com" }, body: "{}" });
    expect((await likeRoute(req, slugCtx())).status).toBe(403);
  });

  it("and a request that is not JSON (a cross-site form post)", async () => {
    stub.session = SESSION;
    const req = new Request(`${SITE}/api/story/story-a/like`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE, host: "news.example.com" }, body: "a=1" });
    expect((await likeRoute(req, slugCtx())).status).toBe(415);
    expect(stub.toggleLike).not.toHaveBeenCalled();
  });
});

describe("signing in", () => {
  it("asks for a code, passing the address and the connection's address", async () => {
    stub.requestCode.mockResolvedValue({ ok: true });
    const res = await codeRoute(post("/api/reader/code", { email: "ada@adorpower.com" }, { "x-forwarded-for": "203.0.113.7" }));
    expect(res.status).toBe(200);
    expect(stub.requestCode).toHaveBeenCalledWith({}, { email: "ada@adorpower.com", ip: "203.0.113.7" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("maps a refusal to its status (422, 429, 500) and keeps the message", async () => {
    for (const [kind, status] of [["invalid", 422], ["limited", 429], ["server", 500]] as const) {
      stub.requestCode.mockResolvedValueOnce({ ok: false, kind, error: `message ${kind}` });
      const res = await codeRoute(post("/api/reader/code", { email: "x@adorpower.com" }));
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ ok: false, error: `message ${kind}` });
    }
  });

  it("answers 404 while sign-in is not available (no mail or no company domains), and 422 for a body without an email", async () => {
    stub.available = false;
    expect((await codeRoute(post("/api/reader/code", { email: "a@adorpower.com" }))).status).toBe(404);
    expect((await verifyRoute(post("/api/reader/verify", { email: "a@adorpower.com", code: "123456" }))).status).toBe(404);
    stub.available = true;
    expect((await codeRoute(post("/api/reader/code", {}))).status).toBe(422);
    expect((await codeRoute(post("/api/reader/code", { email: 5 }))).status).toBe(422);
    expect((await verifyRoute(post("/api/reader/verify", { email: "a@adorpower.com" }))).status).toBe(422);
  });

  it("never logs an address when sending fails", async () => {
    stub.requestCode.mockRejectedValue(new Error("smtp refused ada@adorpower.com"));
    const res = await codeRoute(post("/api/reader/code", { email: "ada@adorpower.com" }));
    expect(res.status).toBe(500);
    expect((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join(" ")).not.toContain("ada@");
  });

  it("starts the session with a signed cookie that is HttpOnly, SameSite=Lax and Secure on https, and does not put the key in the body", async () => {
    stub.verifyCode.mockResolvedValue({ ok: true, session: SESSION });
    const res = await verifyRoute(post("/api/reader/verify", { email: "ada@adorpower.com", code: "123456" }, { "x-forwarded-proto": "https" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: "Ada" });
    const cookie = res.headers.get("set-cookie")!;
    for (const part of ["newsroom_reader=", "HttpOnly", "SameSite=Lax", "Secure", "Path=/", `Max-Age=${14 * 86_400}`]) expect(cookie).toContain(part);
    const value = /newsroom_reader=([^;]+)/.exec(cookie)![1];
    expect(verifySession(value, "reader-test-secret-0123456789", Date.now())).toEqual(SESSION);
  });

  it("a wrong code sets no cookie", async () => {
    stub.verifyCode.mockResolvedValue({ ok: false, kind: "invalid", error: "That code is not right." });
    const res = await verifyRoute(post("/api/reader/verify", { email: "ada@adorpower.com", code: "000000" }));
    expect(res.status).toBe(422);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("signs out by clearing the cookie", async () => {
    const res = await signoutRoute(post("/api/reader/signout"));
    expect(res.headers.get("set-cookie")).toMatch(/newsroom_reader=;.*Max-Age=0/);
  });
});

describe("the story routes", () => {
  it("engagement is public: it says who is signed in and whether sign-in exists, and is never cached", async () => {
    stub.session = SESSION;
    stub.getEngagement.mockResolvedValue({ ok: true, likes: 3, liked: true, comments: [{ id: "m1", name: "Grace", body: "Hi", createdAt: "2026-10-22T10:00:00Z" }] });
    const res = await engagementRoute(new Request(`${SITE}/api/story/story-a/engagement`), slugCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, likes: 3, liked: true, signIn: true, me: { name: "Ada" } });
    expect(JSON.stringify(body)).not.toContain(SESSION.k); // the key never goes back to the browser
    expect(stub.getEngagement).toHaveBeenCalledWith({}, { slug: "story-a", session: SESSION });
  });

  it("a story that is not there is a 404, and a slug that is not a slug never reaches the database", async () => {
    stub.getEngagement.mockResolvedValue({ ok: false, kind: "not_found", error: "This story is not available." });
    expect((await engagementRoute(new Request(`${SITE}/x`), slugCtx())).status).toBe(404);
    for (const slug of ["../etc/passwd", "UPPER", "a b", "x".repeat(300), "-start"]) {
      stub.getEngagement.mockClear();
      expect((await engagementRoute(new Request(`${SITE}/x`), slugCtx(slug))).status, slug).toBe(404);
      expect(stub.getEngagement).not.toHaveBeenCalled();
    }
    expect((await likeRoute(post("/api/story/x/like"), slugCtx("A B"))).status).toBe(404);
    expect((await commentRoute(post("/api/story/x/comments", { body: "hello" }), slugCtx("A B"))).status).toBe(404);
  });

  it("like and comment pass the signed-in reader on, and answer 401 for a visitor", async () => {
    stub.toggleLike.mockResolvedValue({ ok: false, kind: "auth", error: "Sign in with your company email first." });
    expect((await likeRoute(post("/api/story/story-a/like"), slugCtx())).status).toBe(401);
    stub.session = SESSION;
    stub.toggleLike.mockResolvedValue({ ok: true, liked: true, likes: 4 });
    const liked = await likeRoute(post("/api/story/story-a/like"), slugCtx());
    expect(await liked.json()).toEqual({ ok: true, liked: true, likes: 4 });
    expect(stub.toggleLike).toHaveBeenLastCalledWith({}, { slug: "story-a", session: SESSION });

    stub.addComment.mockResolvedValue({ ok: true, comment: { id: "m1", name: "Ada", body: "hello", createdAt: "2026-10-22T10:00:00Z" } });
    const commented = await commentRoute(post("/api/story/story-a/comments", { body: "hello" }), slugCtx());
    expect(commented.status).toBe(201);
    expect(stub.addComment).toHaveBeenCalledWith({}, { slug: "story-a", session: SESSION, body: "hello" });
  });

  it("a comment route refuses a body that is not text, and maps limits to 429", async () => {
    stub.session = SESSION;
    expect((await commentRoute(post("/api/story/story-a/comments", { body: 5 }), slugCtx())).status).toBe(422);
    expect((await commentRoute(post("/api/story/story-a/comments", [1]), slugCtx())).status).toBe(422);
    stub.addComment.mockResolvedValue({ ok: false, kind: "limited", error: "You can write 5 comments an hour." });
    expect((await commentRoute(post("/api/story/story-a/comments", { body: "hello" }), slugCtx())).status).toBe(429);
    stub.toggleLike.mockResolvedValue({ ok: false, kind: "limited", error: "slow down" });
    expect((await likeRoute(post("/api/story/story-a/like"), slugCtx())).status).toBe(429);
  });

  it("a body over 8 KB is refused before it is parsed", async () => {
    stub.session = SESSION;
    const res = await commentRoute(post("/api/story/story-a/comments", { body: "x".repeat(9000) }), slugCtx());
    expect(res.status).toBe(422);
    expect(stub.addComment).not.toHaveBeenCalled();
  });
});