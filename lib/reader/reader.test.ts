import { describe, expect, it, vi } from "vitest";
import { READER_LIMITS as R } from "@/lib/config";
import { sameOrigin } from "@/lib/http/same-origin";
import { hashIp } from "@/lib/submissions/identity";
import {
  BAD_EMAIL, CODE_EXPIRED, requestCode, SEND_FAILED, TOO_MANY_CODES, TOO_MANY_TRIES, verifyCode, WRONG_CODE,
  type AuthDeps, type AuthStore, type CodeRow,
} from "./auth";
import {
  addComment, COMMENT_DAY_LIMIT, COMMENT_DUPLICATE, COMMENT_EMPTY, COMMENT_HOUR_LIMIT, COMMENT_TOO_LONG, getEngagement, LIKE_LIMIT, NOT_FOUND, SIGN_IN_REQUIRED, toggleLike,
  type EngagementDeps, type EngagementStore, type PublicComment,
} from "./engagement";
import { clearedCookie, codeHash, cookieValue, displayName, newCode, newSession, readerKey, READER_COOKIE, safeEqual, sessionCookie, signSession, verifySession, type ReaderSession } from "./identity";

const SECRET = "reader-test-secret-0123456789";
const NOW = new Date("2026-10-22T10:00:00.000Z");

// ---------------------------------------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------------------------------------
describe("the reader's key and name", () => {
  it("is a keyed hash of the lower-cased address: stable, hex, and never the address", () => {
    const k = readerKey("Ada.Lovelace@AdorPower.com", SECRET);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(k).toBe(readerKey("ada.lovelace@adorpower.com", SECRET));
    expect(k).not.toBe(readerKey("ada.lovelace@adorpower.com", "another-secret-0123456789"));
    expect(k).not.toBe(readerKey("ada@adorpower.com", SECRET));
    expect(k).not.toContain("ada");
  });

  it("shows the first name from the start of the address, never the address", () => {
    expect(displayName("ada.lovelace@adorpower.com")).toBe("Ada");
    expect(displayName("GRACE_hopper@x.com")).toBe("Grace");
    expect(displayName("alan+news@x.com")).toBe("Alan");
    expect(displayName("j.doe@x.com")).toBe("Colleague"); // a single letter is not a name
    expect(displayName("12345@x.com")).toBe("Colleague");
    expect(displayName("<script>@x.com")).toBe("Script");
    expect(displayName("a".repeat(80) + "@x.com").length).toBeLessThanOrEqual(30);
    for (const e of ["ada.lovelace@adorpower.com", "grace@x.com"]) expect(displayName(e)).not.toContain("@");
  });

  it("makes six-digit codes with leading zeros kept", () => {
    for (let i = 0; i < 50; i++) expect(newCode()).toMatch(new RegExp(`^\\d{${R.CODE_DIGITS}}$`));
  });

  it("binds a code's hash to the address it was asked for", () => {
    const a = readerKey("a@adorpower.com", SECRET);
    const b = readerKey("b@adorpower.com", SECRET);
    expect(codeHash("123456", a, SECRET)).not.toBe(codeHash("123456", b, SECRET));
    expect(safeEqual(codeHash("123456", a, SECRET), codeHash("123456", a, SECRET))).toBe(true);
    expect(safeEqual("a", "ab")).toBe(false);
  });
});

describe("the session cookie", () => {
  const session = newSession("ada@adorpower.com", SECRET, NOW.getTime());

  it("lasts 14 days and holds the key and the display name, nothing else", () => {
    expect(session.exp).toBe(Math.floor(NOW.getTime() / 1000) + 14 * 86_400);
    expect(Object.keys(session).sort()).toEqual(["exp", "k", "n"]);
    expect(session.n).toBe("Ada");
  });

  it("verifies its own signature, and refuses an altered, foreign, expired or malformed one", () => {
    const value = signSession(session, SECRET);
    expect(verifySession(value, SECRET, NOW.getTime())).toEqual(session);
    expect(verifySession(value, "another-secret-0123456789", NOW.getTime())).toBeNull();
    expect(verifySession(value, SECRET, (session.exp + 1) * 1000)).toBeNull();
    const [payload, sig] = value.split(".");
    const forged = Buffer.from(JSON.stringify({ ...session, k: readerKey("boss@adorpower.com", SECRET) })).toString("base64url");
    expect(verifySession(`${forged}.${sig}`, SECRET, NOW.getTime())).toBeNull();
    expect(verifySession(`${payload}.${"0".repeat(64)}`, SECRET, NOW.getTime())).toBeNull();
    for (const bad of [undefined, null, "", "x", "a.b", ".", `${payload}`, "x".repeat(2000)]) expect(verifySession(bad, SECRET, NOW.getTime())).toBeNull();
  });

  it("is HttpOnly and SameSite=Lax, Secure on https, and is cleared with Max-Age=0", () => {
    const c = sessionCookie("v", true);
    expect(c).toContain(`${READER_COOKIE}=v`);
    for (const part of ["HttpOnly", "SameSite=Lax", "Secure", "Path=/", `Max-Age=${14 * 86_400}`]) expect(c).toContain(part);
    expect(sessionCookie("v", false)).not.toContain("Secure");
    expect(clearedCookie(true)).toContain("Max-Age=0");
  });

  it("is found in a Cookie header among others", () => {
    expect(cookieValue(`a=1; ${READER_COOKIE}=tok.en; b=2`, READER_COOKIE)).toBe("tok.en");
    expect(cookieValue("a=1", READER_COOKIE)).toBeUndefined();
    expect(cookieValue(null, READER_COOKIE)).toBeUndefined();
    expect(cookieValue(`x${READER_COOKIE}=1`, READER_COOKIE)).toBeUndefined();
  });
});

describe("same-origin check", () => {
  const h = (v: Record<string, string>) => ({ get: (n: string) => v[n.toLowerCase()] ?? null });
  it("accepts the site's own pages", () => {
    expect(sameOrigin(h({ origin: "https://news.example.com", host: "news.example.com" }))).toBe(true);
    expect(sameOrigin(h({ origin: "https://news.example.com", host: "internal:3000", "x-forwarded-host": "news.example.com" }))).toBe(true);
    expect(sameOrigin(h({ "sec-fetch-site": "same-origin", host: "x" }))).toBe(true);
  });
  it("refuses another site, a missing Origin, and cross-site fetches", () => {
    expect(sameOrigin(h({ origin: "https://evil.example", host: "news.example.com" }))).toBe(false);
    expect(sameOrigin(h({ origin: "https://news.example.com.evil.io", host: "news.example.com" }))).toBe(false);
    expect(sameOrigin(h({ origin: "null", host: "news.example.com" }))).toBe(false);
    expect(sameOrigin(h({ host: "news.example.com" }))).toBe(false);
    expect(sameOrigin(h({ "sec-fetch-site": "cross-site", host: "news.example.com" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Sign-in with a code
// ---------------------------------------------------------------------------------------------------------------------
function authSetup(over: { sendFails?: boolean; code?: string } = {}) {
  const clock = { now: NOW };
  const rows: (CodeRow & { email_key: string; ip_hash: string | null; created_at: string })[] = [];
  const sent: { to: string; code: string }[] = [];
  let n = 0;
  const store: AuthStore = {
    countCodes: async ({ emailKey, ipHash, sinceIso }) => ({
      email: rows.filter((r) => r.email_key === emailKey && r.created_at >= sinceIso).length,
      ip: ipHash ? rows.filter((r) => r.ip_hash === ipHash && r.created_at >= sinceIso).length : null,
    }),
    insertCode: async ({ emailKey, codeHash: hash, ipHash, expiresAtIso }) => {
      rows.push({ id: `c${++n}`, code_hash: hash, attempts: 0, expires_at: expiresAtIso, used_at: null, email_key: emailKey, ip_hash: ipHash, created_at: clock.now.toISOString() });
    },
    latestCode: async (emailKey) => [...rows].reverse().find((r) => r.email_key === emailKey) ?? null,
    registerAttempt: async (id, max) => {
      const r = rows.find((x) => x.id === id)!;
      if (r.attempts >= max || r.used_at) return null;
      return ++r.attempts;
    },
    markUsed: async (id, nowIso) => {
      const r = rows.find((x) => x.id === id)!;
      if (r.used_at) return false;
      r.used_at = nowIso;
      return true;
    },
    prune: async () => {},
  };
  const deps: AuthDeps = {
    store,
    allowedDomains: ["adorpower.com"],
    secret: SECRET,
    hashIp: (ip) => hashIp(ip, SECRET),
    now: () => clock.now,
    makeCode: () => over.code ?? "123456",
    sendCode: async (to, code) => {
      if (over.sendFails) throw new Error(`smtp refused ${to}`);
      sent.push({ to, code });
    },
  };
  return { deps, rows, sent, clock };
}

describe("asking for a code", () => {
  it("sends a code to a company address, stores only its hash, and does not store the address", async () => {
    const t = authSetup();
    expect(await requestCode(t.deps, { email: "  Ada@AdorPower.com ", ip: "203.0.113.7" })).toEqual({ ok: true });
    expect(t.sent).toEqual([{ to: "ada@adorpower.com", code: "123456" }]);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0].code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(t.rows)).not.toMatch(/ada|123456|203\.0\.113\.7/i);
    expect(new Date(t.rows[0].expires_at).getTime() - NOW.getTime()).toBe(R.CODE_TTL_MINUTES * 60_000);
  });

  it("refuses an address that is not an address, or not on the company domains, without sending anything", async () => {
    const t = authSetup();
    expect(await requestCode(t.deps, { email: "nonsense", ip: null })).toMatchObject({ ok: false, error: BAD_EMAIL });
    expect(await requestCode(t.deps, { email: "ada@gmail.com", ip: null })).toMatchObject({ ok: false, kind: "invalid", error: expect.stringContaining("@adorpower.com") });
    expect(await requestCode(t.deps, { email: "ada@adorpower.com.evil.io", ip: null })).toMatchObject({ ok: false });
    expect(t.sent).toEqual([]);
  });

  it("allows five codes an hour per address and twenty per connection, then says so", async () => {
    const t = authSetup();
    for (let i = 0; i < R.CODES_PER_EMAIL_PER_HOUR; i++) expect(await requestCode(t.deps, { email: "ada@adorpower.com", ip: `198.51.100.${i}` })).toEqual({ ok: true });
    expect(await requestCode(t.deps, { email: "ada@adorpower.com", ip: "198.51.100.99" })).toMatchObject({ ok: false, kind: "limited", error: TOO_MANY_CODES });
    expect(await requestCode(t.deps, { email: "grace@adorpower.com", ip: "198.51.100.99" })).toEqual({ ok: true });

    const t2 = authSetup();
    for (let i = 0; i < R.CODES_PER_IP_PER_HOUR; i++) expect(await requestCode(t2.deps, { email: `p${i}@adorpower.com`, ip: "203.0.113.7" })).toEqual({ ok: true });
    expect(await requestCode(t2.deps, { email: "next@adorpower.com", ip: "203.0.113.7" })).toMatchObject({ ok: false, kind: "limited" });
    // an hour later the counts start again
    t2.clock.now = new Date(NOW.getTime() + 3_600_001);
    expect(await requestCode(t2.deps, { email: "next@adorpower.com", ip: "203.0.113.7" })).toEqual({ ok: true });
  });

  it("a mail failure is reported without the cause or the address", async () => {
    const t = authSetup({ sendFails: true });
    const r = await requestCode(t.deps, { email: "ada@adorpower.com", ip: null });
    expect(r).toEqual({ ok: false, kind: "server", error: SEND_FAILED });
    expect(JSON.stringify(r)).not.toMatch(/smtp|ada/);
  });
});

describe("entering the code", () => {
  const ask = async (t: ReturnType<typeof authSetup>, email = "ada@adorpower.com") => requestCode(t.deps, { email, ip: null });

  it("starts a 14-day session for the right code, once", async () => {
    const t = authSetup();
    await ask(t);
    const r = await verifyCode(t.deps, { email: "ADA@adorpower.com", code: " 123 456 " });
    expect(r.ok && r.session).toEqual(newSession("ada@adorpower.com", SECRET, NOW.getTime()));
    expect(await verifyCode(t.deps, { email: "ada@adorpower.com", code: "123456" })).toMatchObject({ ok: false, error: CODE_EXPIRED }); // already used
  });

  it("a wrong code is refused, and five wrong tries lock that code, even for the right one afterwards", async () => {
    const t = authSetup();
    await ask(t);
    for (let i = 0; i < R.CODE_MAX_ATTEMPTS; i++) expect(await verifyCode(t.deps, { email: "ada@adorpower.com", code: "000000" })).toMatchObject({ ok: false, error: WRONG_CODE });
    expect(await verifyCode(t.deps, { email: "ada@adorpower.com", code: "000000" })).toMatchObject({ ok: false, kind: "limited", error: TOO_MANY_TRIES });
    expect(await verifyCode(t.deps, { email: "ada@adorpower.com", code: "123456" })).toMatchObject({ ok: false, kind: "limited" });
  });

  it("many guesses at once still get only five comparisons (the try is counted first, atomically)", async () => {
    const t = authSetup();
    await ask(t);
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => verifyCode(t.deps, { email: "ada@adorpower.com", code: String(i).padStart(6, "0") })));
    expect(results.filter((r) => !r.ok && r.error === WRONG_CODE)).toHaveLength(R.CODE_MAX_ATTEMPTS - (results.some((r) => r.ok) ? 1 : 0));
    expect(results.filter((r) => !r.ok && r.kind === "limited").length).toBeGreaterThanOrEqual(45 - 1);
  });

  it("a code expires after ten minutes", async () => {
    const t = authSetup();
    await ask(t);
    t.clock.now = new Date(NOW.getTime() + R.CODE_TTL_MINUTES * 60_000 + 1);
    expect(await verifyCode(t.deps, { email: "ada@adorpower.com", code: "123456" })).toMatchObject({ ok: false, error: CODE_EXPIRED });
  });

  it("a code asked for by one person cannot be used by another", async () => {
    const t = authSetup();
    await ask(t, "ada@adorpower.com");
    expect(await verifyCode(t.deps, { email: "grace@adorpower.com", code: "123456" })).toMatchObject({ ok: false, error: CODE_EXPIRED });
  });

  it("only the newest code works", async () => {
    let next = "111111";
    const t = authSetup();
    t.deps.makeCode = () => next;
    await ask(t);
    next = "222222";
    await ask(t);
    expect(await verifyCode(t.deps, { email: "ada@adorpower.com", code: "111111" })).toMatchObject({ ok: false, error: WRONG_CODE });
    expect((await verifyCode(t.deps, { email: "ada@adorpower.com", code: "222222" })).ok).toBe(true);
  });

  it("refuses a code that is not six digits, and an address off the domain list", async () => {
    const t = authSetup();
    await ask(t);
    for (const code of ["12345", "1234567", "abcdef", "", "12 34"]) expect(await verifyCode(t.deps, { email: "ada@adorpower.com", code })).toMatchObject({ ok: false, kind: "invalid" });
    expect(await verifyCode(t.deps, { email: "ada@gmail.com", code: "123456" })).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Likes and comments
// ---------------------------------------------------------------------------------------------------------------------
type CommentRow = PublicComment & { userKey: string; status: "visible" | "hidden"; articleId: string };

function engagementSetup(over: { format?: "plain" | "blocks"; published?: boolean } = {}) {
  const clock = { now: NOW };
  const likes = new Set<string>();
  const toggles: { userKey: string; at: string }[] = [];
  const comments: CommentRow[] = [];
  const store: EngagementStore = {
    article: async (slug) => (slug === "story-a" && over.published !== false ? { id: "a1", format: over.format ?? "blocks" } : null),
    likeCount: async (id) => [...likes].filter((l) => l.startsWith(`${id}:`)).length,
    hasLiked: async (id, k) => likes.has(`${id}:${k}`),
    addLike: async (id, k) => void likes.add(`${id}:${k}`),
    removeLike: async (id, k) => void likes.delete(`${id}:${k}`),
    likeToggles: async (k, since) => toggles.filter((t) => t.userKey === k && t.at >= since).length,
    logLikeToggle: async (k) => void toggles.push({ userKey: k, at: clock.now.toISOString() }),
    comments: async (id, limit) => comments.filter((c) => c.articleId === id && c.status === "visible").sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit),
    commentCount: async (k, since) => comments.filter((c) => c.userKey === k && c.createdAt >= since).length,
    recentCommentBodies: async (k, since) => comments.filter((c) => c.userKey === k && c.createdAt >= since).map((c) => c.body),
    addComment: async ({ articleId, userKey, displayName: name, body }) => {
      const row: CommentRow = { id: `m${comments.length + 1}`, articleId, userKey, name, body, createdAt: clock.now.toISOString(), status: "visible" };
      comments.push(row);
      return { id: row.id, name, body, createdAt: row.createdAt };
    },
  };
  const deps: EngagementDeps = { store, now: () => clock.now };
  return { deps, likes, comments, clock, toggles };
}

const me: ReaderSession = { k: readerKey("ada@adorpower.com", SECRET), n: "Ada", exp: 4_000_000_000 };
const you: ReaderSession = { k: readerKey("grace@adorpower.com", SECRET), n: "Grace", exp: 4_000_000_000 };

describe("likes", () => {
  it("need a signed-in reader: there are no anonymous likes", async () => {
    const t = engagementSetup();
    expect(await toggleLike(t.deps, { slug: "story-a", session: null })).toMatchObject({ ok: false, kind: "auth", error: SIGN_IN_REQUIRED });
    expect(t.likes.size).toBe(0);
  });

  it("like, then unlike; one like per person; the count follows", async () => {
    const t = engagementSetup();
    expect(await toggleLike(t.deps, { slug: "story-a", session: me })).toEqual({ ok: true, liked: true, likes: 1 });
    expect(await toggleLike(t.deps, { slug: "story-a", session: you })).toEqual({ ok: true, liked: true, likes: 2 });
    expect(await toggleLike(t.deps, { slug: "story-a", session: me })).toEqual({ ok: true, liked: false, likes: 1 });
    expect(await getEngagement(t.deps, { slug: "story-a", session: you })).toMatchObject({ ok: true, likes: 1, liked: true });
    expect(await getEngagement(t.deps, { slug: "story-a", session: me })).toMatchObject({ liked: false });
    expect(await getEngagement(t.deps, { slug: "story-a", session: null })).toMatchObject({ likes: 1, liked: false });
  });

  it("are limited to 30 toggles an hour and 200 a day, counted whether they like or unlike", async () => {
    const t = engagementSetup();
    for (let i = 0; i < R.LIKE_TOGGLES_PER_HOUR; i++) expect((await toggleLike(t.deps, { slug: "story-a", session: me })).ok).toBe(true);
    expect(await toggleLike(t.deps, { slug: "story-a", session: me })).toMatchObject({ ok: false, kind: "limited", error: LIKE_LIMIT });
    expect((await toggleLike(t.deps, { slug: "story-a", session: you })).ok).toBe(true); // another person is not affected
    t.clock.now = new Date(NOW.getTime() + 3_600_001);
    expect((await toggleLike(t.deps, { slug: "story-a", session: me })).ok).toBe(true); // an hour later
  });

  it("the daily limit holds even when each hour is within its own", async () => {
    const t = engagementSetup();
    for (let h = 0; h < 7; h++) {
      t.clock.now = new Date(NOW.getTime() + h * 3_600_001);
      for (let i = 0; i < 29; i++) await toggleLike(t.deps, { slug: "story-a", session: me });
    }
    expect(t.toggles.length).toBe(R.LIKE_TOGGLES_PER_DAY); // 7 x 29 = 203 were tried: the last three were refused
  });

  it("only exist on published Write stories", async () => {
    expect(await toggleLike(engagementSetup({ format: "plain" }).deps, { slug: "story-a", session: me })).toMatchObject({ ok: false, kind: "not_found", error: NOT_FOUND });
    expect(await toggleLike(engagementSetup({ published: false }).deps, { slug: "story-a", session: me })).toMatchObject({ ok: false, kind: "not_found" });
    expect(await getEngagement(engagementSetup().deps, { slug: "nope", session: null })).toMatchObject({ ok: false, kind: "not_found" });
  });
});

describe("comments", () => {
  const post = (t: ReturnType<typeof engagementSetup>, body: string, session: ReaderSession | null = me) => addComment(t.deps, { slug: "story-a", session, body });

  it("need a signed-in reader", async () => {
    const t = engagementSetup();
    expect(await post(t, "Nice story.", null)).toMatchObject({ ok: false, kind: "auth" });
    expect(t.comments).toHaveLength(0);
  });

  it("are stored with the first name, never the address, and show newest first", async () => {
    const t = engagementSetup();
    const first = await post(t, "First comment.");
    t.clock.now = new Date(NOW.getTime() + 1000);
    await post(t, "Second comment.", you);
    expect(first).toMatchObject({ ok: true, comment: { name: "Ada", body: "First comment." } });
    const shown = await getEngagement(t.deps, { slug: "story-a", session: null });
    expect(shown.ok && shown.comments.map((c) => `${c.name}: ${c.body}`)).toEqual(["Grace: Second comment.", "Ada: First comment."]);
    expect(JSON.stringify(shown)).not.toMatch(/adorpower|user_key|userKey/);
  });

  it("strips control characters, and refuses empty and over-long comments", async () => {
    const t = engagementSetup();
    const ok = await post(t, "Hello\u0000 wor​ld‮!");
    expect(ok.ok && ok.comment.body).toBe("Hello world!");
    expect(await post(t, "   ")).toMatchObject({ ok: false, kind: "invalid", error: COMMENT_EMPTY });
    expect(await post(t, "x")).toMatchObject({ ok: false, error: COMMENT_EMPTY });
    expect(await post(t, "x".repeat(R.COMMENT_MAX + 1))).toMatchObject({ ok: false, error: COMMENT_TOO_LONG });
    expect((await post(t, "y".repeat(R.COMMENT_MAX))).ok).toBe(true);
  });

  it("keeps markup as text (it is escaped when drawn)", async () => {
    const t = engagementSetup();
    const r = await post(t, "<script>alert(1)</script> <img src=x onerror=alert(1)>");
    expect(r.ok && r.comment.body).toBe("<script>alert(1)</script> <img src=x onerror=alert(1)>");
  });

  it("refuses the same comment twice, ignoring case and spacing", async () => {
    const t = engagementSetup();
    expect((await post(t, "Great read, thanks!")).ok).toBe(true);
    expect(await post(t, "  GREAT   read,\nthanks! ")).toMatchObject({ ok: false, kind: "invalid", error: COMMENT_DUPLICATE });
    expect((await post(t, "Great read, thanks!", you)).ok).toBe(true); // another person may say the same
  });

  it("allows five comments an hour and twenty a day", async () => {
    const t = engagementSetup();
    for (let i = 0; i < R.COMMENTS_PER_HOUR; i++) expect((await post(t, `Comment number ${i}`)).ok).toBe(true);
    expect(await post(t, "One more comment")).toMatchObject({ ok: false, kind: "limited", error: COMMENT_HOUR_LIMIT });

    // spread over the day: four an hour for five hours is twenty
    const d = engagementSetup();
    for (let h = 0; h < 5; h++) {
      d.clock.now = new Date(NOW.getTime() + h * 3_600_001);
      for (let i = 0; i < 4; i++) expect((await post(d, `Comment ${h}-${i}`)).ok, `${h}-${i}`).toBe(true);
    }
    d.clock.now = new Date(NOW.getTime() + 5 * 3_600_001);
    expect(await post(d, "The twenty-first")).toMatchObject({ ok: false, kind: "limited", error: COMMENT_DAY_LIMIT });
    d.clock.now = new Date(NOW.getTime() + 25 * 3_600_000);
    expect((await post(d, "The next day")).ok).toBe(true);
  });

  it("a hidden comment still counts towards the person's limit and is not shown", async () => {
    const t = engagementSetup();
    for (let i = 0; i < R.COMMENTS_PER_HOUR; i++) await post(t, `Comment number ${i}`);
    for (const c of t.comments) c.status = "hidden";
    const shown = await getEngagement(t.deps, { slug: "story-a", session: null });
    expect(shown.ok && shown.comments).toEqual([]);
    expect(await post(t, "Trying again")).toMatchObject({ ok: false, kind: "limited" });
  });

  it("only exist on published Write stories", async () => {
    expect(await post(engagementSetup({ format: "plain" }), "Hello there")).toMatchObject({ ok: false, kind: "not_found" });
  });

  it("a storage failure is reported without its cause", async () => {
    const t = engagementSetup();
    t.deps.store.addComment = async () => {
      throw new Error("relation article_comments does not exist for ada@adorpower.com");
    };
    const r = await post(t, "Hello there");
    expect(r).toMatchObject({ ok: false, kind: "server" });
    expect(JSON.stringify(r)).not.toMatch(/relation|ada/);
  });
});

void vi;
