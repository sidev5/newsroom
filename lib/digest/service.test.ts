import { describe, expect, it, vi } from "vitest";
import { createNoneProvider } from "@/lib/mail";
import { MailError, type MailMessage, type MailProvider } from "@/lib/mail/types";
import { addRecipients, parseRecipients, removeRecipient, setRecipientActive } from "./recipients";
import { article, createMemoryStore, digestRow } from "./memory-store";
import { digestSubject, hasPhoto, oneLiner, selectStories, summarySentences } from "./select";
import {
  adminCreateDraft,
  approveDigest,
  BATCH_SIZE,
  createDraft,
  NO_CANDIDATES,
  recipientCount,
  runScheduledSend,
  sendDigestNow,
  sendTestToAdmin,
  unapproveDigest,
  updateDigest,
  type DigestDeps,
  type ReminderDeps,
  type SendDeps,
} from "./service";
import { kolkataDate, weekStart, windowStart } from "./week";

const ADMIN = "editor@example.com";
// Monday 2026-10-19, 08:30 IST
const NOW = new Date("2026-10-19T03:00:00.000Z");
const days = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

type Opts = { admin?: string | null; maxStories?: number; dl?: string | null; now?: Date };

function setup(seed: Parameters<typeof createMemoryStore>[0] = {}, o: Opts = {}) {
  const mem = createMemoryStore(seed);
  const deps: DigestDeps = {
    store: mem.store,
    adminEmail: async () => (o.admin === undefined ? ADMIN : o.admin),
    now: () => o.now ?? NOW,
    maxStories: o.maxStories ?? 6,
    distributionList: o.dl ?? null,
  };
  return { mem, deps };
}

function mailer(over: Partial<MailProvider> = {}) {
  const sent: MailMessage[] = [];
  const provider: MailProvider = {
    name: "smtp",
    supportsInlineImages: true,
    send: vi.fn(async (m: MailMessage) => void sent.push(m)),
    ...over,
  };
  return { provider, sent };
}

function sendSetup(seed: Parameters<typeof createMemoryStore>[0] = {}, o: Opts = {}, providerOver: Partial<MailProvider> = {}) {
  const { mem, deps } = setup(seed, o);
  const m = mailer(providerOver);
  const buildMail = vi.fn(async () => ({ subject: "Company Newsroom weekly: Headline a1", html: "<p>html</p>", text: "text" }));
  const send: SendDeps = { ...deps, provider: m.provider, buildMail, from: "Company Newsroom <newsroom@example.com>" };
  const remind: ReminderDeps = { ...send, adminEmails: [ADMIN, "second@example.com"], siteUrl: "https://newsroom.example.com" };
  return { mem, deps, send, remind, buildMail, ...m };
}

const approved = (over = {}) => digestRow({ status: "approved", approved_by: ADMIN, approved_at: NOW.toISOString(), week_start: "2026-10-19", ...over });

// ---------------------------------------------------------------------------
// Week
// ---------------------------------------------------------------------------
describe("week key (Asia/Kolkata)", () => {
  it("is the Monday of the current week", () => {
    expect(weekStart(new Date("2026-10-19T03:00:00Z"))).toBe("2026-10-19"); // Monday 08:30 IST
    expect(weekStart(new Date("2026-10-22T12:00:00Z"))).toBe("2026-10-19"); // Thursday
    expect(weekStart(new Date("2026-10-25T10:00:00Z"))).toBe("2026-10-19"); // Sunday afternoon IST
  });

  it("uses the Kolkata calendar, not UTC, at the week boundary", () => {
    // 18:30 UTC Sunday is 00:00 Monday in IST.
    expect(weekStart(new Date("2026-10-18T18:29:59Z"))).toBe("2026-10-12");
    expect(weekStart(new Date("2026-10-18T18:30:00Z"))).toBe("2026-10-19");
    expect(kolkataDate(new Date("2026-10-18T20:00:00Z"))).toBe("2026-10-19");
  });

  it("windows 7 days back", () => {
    expect(windowStart(NOW).toISOString()).toBe(days(7));
  });
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------
describe("selectStories", () => {
  const dept = (slug: string) => ({ name: slug, slug });

  it("leads with the newest story that has a photo", () => {
    const picked = selectStories(
      [article("new", { published_at: days(0.5), image_url: null }), article("photo", { published_at: days(1) }), article("old", { published_at: days(3) })],
      3,
    );
    expect(picked[0].id).toBe("photo");
    expect(picked.map((a) => a.id)).toEqual(["photo", "new", "old"]);
  });

  it("falls back to the newest story when none has a photo", () => {
    const picked = selectStories([article("a", { published_at: days(2), image_url: null }), article("b", { published_at: days(1), image_url: null })], 2);
    expect(picked[0].id).toBe("b");
  });

  it("keeps the digest department-diverse: a department's second story waits for the others", () => {
    const picked = selectStories(
      [
        article("ev1", { published_at: days(1), department: dept("ev") }),
        article("ev2", { published_at: days(1.1), department: dept("ev") }),
        article("ev3", { published_at: days(1.2), department: dept("ev") }),
        article("bat", { published_at: days(2), department: dept("batteries") }),
        article("def", { published_at: days(3), department: dept("defence") }),
      ],
      4,
    );
    expect(picked.map((a) => a.id)).toEqual(["ev1", "bat", "def", "ev2"]);
  });

  it("is deterministic whatever the input order", () => {
    const list = ["a", "b", "c", "d"].map((id, i) => article(id, { published_at: days(i), department: dept(i % 2 ? "x" : "y") }));
    expect(selectStories([...list].reverse(), 4).map((a) => a.id)).toEqual(selectStories(list, 4).map((a) => a.id));
  });

  it("limits to max, and max 1 gives a single story", () => {
    const list = ["a", "b", "c"].map((id, i) => article(id, { published_at: days(i) }));
    expect(selectStories(list, 2)).toHaveLength(2);
    expect(selectStories(list, 1).map((a) => a.id)).toEqual(["a"]);
    expect(selectStories([], 6)).toEqual([]);
  });

  it("counts only https photos", () => {
    expect(hasPhoto({ image_url: "https://images.unsplash.com/x" })).toBe(true);
    expect(hasPhoto({ image_url: "/images/defaults/ev.svg" })).toBe(false);
    expect(hasPhoto({ image_url: null })).toBe(false);
  });
});

describe("text helpers", () => {
  it("summarises in up to three whole sentences", () => {
    expect(summarySentences("One. Two. Three. Four.")).toBe("One. Two. Three.");
    expect(summarySentences("Only one sentence here")).toBe("Only one sentence here");
    expect(summarySentences("A".repeat(600))).toMatch(/…$/);
  });
  it("gives a one-line teaser", () => {
    expect(oneLiner("First sentence. Second sentence.")).toBe("First sentence.");
    expect(oneLiner("x ".repeat(200)).length).toBeLessThanOrEqual(130);
  });
  it("keeps the subject within 90 characters", () => {
    const short = digestSubject("Short headline");
    expect(short).toBe("Company Newsroom weekly: Short headline");
    const long = digestSubject("word ".repeat(60));
    expect(long.length).toBeLessThanOrEqual(90);
    expect(long.startsWith("Company Newsroom weekly: ")).toBe(true);
    expect(long.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Candidates and the draft
// ---------------------------------------------------------------------------
describe("createDraft", () => {
  const seed = (extra: ReturnType<typeof article>[] = []) => ({
    articles: [
      article("a1", { published_at: days(1) }),
      article("a2", { published_at: days(3), department: { name: "Batteries", slug: "batteries" } }),
      article("a3", { published_at: days(6.5), department: { name: "Defence", slug: "defence" } }),
      article("old", { published_at: days(8) }), // outside the window
      ...extra,
    ],
  });

  it("uses published articles from the last 7 days, newest lead, with subject and the fixed intro", async () => {
    const { deps, mem } = setup(seed());
    const r = await createDraft(deps, "cron");
    expect(r.kind).toBe("created");
    expect(r.digest).toMatchObject({ week_start: "2026-10-19", status: "draft", lead_article_id: "a1", article_ids: ["a1", "a2", "a3"] });
    expect(r.digest.subject).toBe("Company Newsroom weekly: Headline a1");
    expect(r.digest.intro).toMatch(/Company Newsroom/);
    expect(mem.logs.map((l) => l.action)).toEqual(["draft_created"]);
  });

  it("leaves out articles used by an earlier digest that was sent or approved", async () => {
    const { deps } = setup({
      ...seed(),
      digests: [digestRow({ id: "prev", week_start: "2026-10-12", status: "sent", article_ids: ["a1"] })],
    });
    expect((await createDraft(deps, "cron")).digest.article_ids).toEqual(["a2", "a3"]);
    const approvedBefore = setup({ ...seed(), digests: [digestRow({ id: "prev", week_start: "2026-10-12", status: "approved", article_ids: ["a2"] })] });
    expect((await createDraft(approvedBefore.deps, "cron")).digest.article_ids).toEqual(["a1", "a3"]);
  });

  it("still offers articles from an earlier digest that never went out (draft, failed, skipped)", async () => {
    for (const status of ["draft", "failed", "skipped"] as const) {
      const { deps } = setup({ ...seed(), digests: [digestRow({ id: "prev", week_start: "2026-10-12", status, article_ids: ["a1"] })] });
      expect((await createDraft(deps, "cron")).digest.article_ids).toContain("a1");
    }
  });

  it("makes a single-story digest when DIGEST_MAX_STORIES is 1", async () => {
    const { deps } = setup(seed(), { maxStories: 1 });
    expect((await createDraft(deps, "cron")).digest.article_ids).toEqual(["a1"]);
  });

  it("caps at DIGEST_MAX_STORIES, lead included", async () => {
    const { deps } = setup(seed(), { maxStories: 2 });
    expect((await createDraft(deps, "cron")).digest.article_ids).toHaveLength(2);
  });

  it("is skipped, with a message, when there is nothing new", async () => {
    const { deps, mem } = setup({ articles: [article("old", { published_at: days(9) })] });
    const r = await createDraft(deps, "cron");
    expect(r).toMatchObject({ kind: "skipped", reason: NO_CANDIDATES });
    expect(r.digest).toMatchObject({ status: "skipped", article_ids: [], error: NO_CANDIDATES });
    expect(mem.logs.map((l) => l.action)).toEqual(["draft_skipped"]);
  });

  it("tells the admin when the button finds nothing", async () => {
    const { deps } = setup({ articles: [] });
    const r = await adminCreateDraft(deps);
    expect(r).toMatchObject({ ok: true, draft: { kind: "skipped", reason: NO_CANDIDATES } });
  });

  it("re-checks a skipped week in place, without a second row", async () => {
    const { deps, mem } = setup({ articles: [] });
    await createDraft(deps, "cron");
    mem.articles.push(article("new", { published_at: days(1) }));
    const r = await createDraft(deps, "cron");
    expect(r.kind).toBe("created");
    expect(mem.digests).toHaveLength(1);
  });

  it("never creates a second digest for a week, and leaves an existing draft alone", async () => {
    const { deps, mem } = setup(seed());
    const first = await createDraft(deps, "cron");
    await updateDigest(deps, first.digest.id, { subject: "My subject", intro: "Mine", articleIds: ["a2"] });
    const again = await createDraft(deps, ADMIN);
    expect(again.kind).toBe("exists");
    expect(again.digest).toMatchObject({ subject: "My subject", article_ids: ["a2"] });
    expect(mem.digests).toHaveLength(1);
  });

  it("two runs at once still make one digest", async () => {
    const { deps, mem } = setup(seed());
    const [a, b] = await Promise.all([createDraft(deps, "cron"), createDraft(deps, ADMIN)]);
    expect(mem.digests).toHaveLength(1);
    expect(a.digest.id).toBe(b.digest.id);
  });

  it("leaves an approved or sent digest untouched", async () => {
    const { deps, mem } = setup({ ...seed(), digests: [approved({ article_ids: ["a2"] })] });
    const r = await createDraft(deps, "cron");
    expect(r.kind).toBe("exists");
    expect(mem.digests[0].article_ids).toEqual(["a2"]);
  });
});

// ---------------------------------------------------------------------------
// Admin-only and approval rules
// ---------------------------------------------------------------------------
describe("admin checks", () => {
  it.each([
    ["create draft", (d: DigestDeps) => adminCreateDraft(d)],
    ["edit", (d: DigestDeps) => updateDigest(d, "d1", { subject: "S", intro: "", articleIds: ["a1"] })],
    ["approve", (d: DigestDeps) => approveDigest(d, "d1")],
    ["unapprove", (d: DigestDeps) => unapproveDigest(d, "d1")],
  ])("%s is refused for a non-admin and changes nothing", async (_n, act) => {
    const { deps, mem } = setup({ articles: [article("a1", { published_at: days(1) })], digests: [digestRow({ week_start: "2026-10-19" })], recipients: ["a@example.com"] }, { admin: null });
    const before = JSON.stringify(mem.digests);
    expect(await act(deps)).toEqual({ ok: false, error: "Not authorised." });
    expect(JSON.stringify(mem.digests)).toBe(before);
    expect(mem.logs).toEqual([]);
  });

  it("send test and send now are refused for a non-admin, and send nothing", async () => {
    const s = sendSetup({ articles: [article("a1")], digests: [approved()], recipients: ["a@example.com"] }, { admin: null });
    expect(await sendTestToAdmin(s.send, "d1")).toEqual({ ok: false, error: "Not authorised." });
    expect(await sendDigestNow(s.send, "d1")).toEqual({ ok: false, error: "Not authorised." });
    expect(s.provider.send).not.toHaveBeenCalled();
    expect(s.mem.digests[0].status).toBe("approved");
  });

  it("recipient changes are refused for a non-admin", async () => {
    const mem = createMemoryStore({ recipients: ["keep@example.com"] });
    const rd = { recipients: mem.recipientStore, adminEmail: async () => null, log: mem.store.log };
    expect(await addRecipients(rd, "new@example.com")).toEqual({ ok: false, error: "Not authorised." });
    expect(await removeRecipient(rd, "r0")).toEqual({ ok: false, error: "Not authorised." });
    expect(await setRecipientActive(rd, "r0", false)).toEqual({ ok: false, error: "Not authorised." });
    expect(mem.recipients).toHaveLength(1);
    expect(mem.logs).toEqual([]);
  });
});

describe("approval", () => {
  const base = () => ({ articles: [article("a1", { published_at: days(1) }), article("a2", { published_at: days(2) })], digests: [digestRow({ week_start: "2026-10-19", article_ids: ["a1", "a2"] })], recipients: ["a@example.com"] });

  it("approve records who and when, and logs it", async () => {
    const { deps, mem } = setup(base());
    expect(await approveDigest(deps, "d1")).toEqual({ ok: true });
    expect(mem.digests[0]).toMatchObject({ status: "approved", approved_by: ADMIN, approved_at: NOW.toISOString() });
    expect(mem.logs).toEqual([{ digestId: "d1", action: "approve", actor: ADMIN, detail: undefined }]);
  });

  it("needs a recipient, or a distribution list", async () => {
    const none = setup({ ...base(), recipients: [] });
    expect(await approveDigest(none.deps, "d1")).toMatchObject({ ok: false, error: expect.stringContaining("recipient") });
    const dl = setup({ ...base(), recipients: [] }, { dl: "everyone@example.com" });
    expect(await approveDigest(dl.deps, "d1")).toEqual({ ok: true });
  });

  it("only a draft can be approved", async () => {
    for (const status of ["approved", "sending", "sent", "failed", "skipped"] as const) {
      const { deps } = setup({ ...base(), digests: [digestRow({ status, week_start: "2026-10-19", article_ids: ["a1"] })] });
      expect((await approveDigest(deps, "d1")).ok).toBe(false);
    }
  });

  it("any edit after approval resets it to draft, so it must be approved again", async () => {
    const { deps, mem } = setup(base());
    await approveDigest(deps, "d1");
    const r = await updateDigest(deps, "d1", { subject: "A new subject", intro: "Intro.", articleIds: ["a1", "a2"] });
    expect(r).toEqual({ ok: true, approvalReset: true, changed: true });
    expect(mem.digests[0]).toMatchObject({ status: "draft", approved_by: null, approved_at: null, subject: "A new subject" });
    expect(mem.logs.map((l) => l.action)).toEqual(["approve", "edit", "approval_reset"]);
  });

  it.each([
    ["the subject", { subject: "Other subject" }],
    ["the intro", { intro: "Other intro" }],
    ["the order (the lead)", { articleIds: ["a2", "a1"] }],
    ["the story list", { articleIds: ["a1"] }],
  ])("changing %s resets approval", async (_n, change) => {
    const { deps, mem } = setup(base());
    await approveDigest(deps, "d1");
    const r = await updateDigest(deps, "d1", { subject: "Company Newsroom weekly: Headline a1", intro: "Intro.", articleIds: ["a1", "a2"], ...change });
    expect(r).toMatchObject({ ok: true, approvalReset: true });
    expect(mem.digests[0].status).toBe("draft");
  });

  it("saving with no change keeps the approval", async () => {
    const { deps, mem } = setup(base());
    await approveDigest(deps, "d1");
    const r = await updateDigest(deps, "d1", { subject: mem.digests[0].subject, intro: mem.digests[0].intro, articleIds: ["a1", "a2"] });
    expect(r).toEqual({ ok: true, approvalReset: false, changed: false });
    expect(mem.digests[0].status).toBe("approved");
  });

  it("sets the first story as the lead", async () => {
    const { deps, mem } = setup(base());
    await updateDigest(deps, "d1", { subject: "S", intro: "", articleIds: ["a2", "a1"] });
    expect(mem.digests[0]).toMatchObject({ lead_article_id: "a2", article_ids: ["a2", "a1"] });
  });

  it("validates the edit", async () => {
    const { deps, mem } = setup(base());
    const before = JSON.stringify(mem.digests);
    expect(await updateDigest(deps, "d1", { subject: "", intro: "", articleIds: ["a1"] })).toMatchObject({ ok: false });
    expect(await updateDigest(deps, "d1", { subject: "x".repeat(91), intro: "", articleIds: ["a1"] })).toMatchObject({ ok: false });
    expect(await updateDigest(deps, "d1", { subject: "S", intro: "x".repeat(601), articleIds: ["a1"] })).toMatchObject({ ok: false });
    expect(await updateDigest(deps, "d1", { subject: "S", intro: "", articleIds: [] })).toMatchObject({ ok: false });
    expect(await updateDigest(deps, "d1", { subject: "S", intro: "", articleIds: ["nope"] })).toMatchObject({ ok: false, error: expect.stringContaining("not published") });
    expect(JSON.stringify(mem.digests)).toBe(before);
  });

  it("a digest that is sending or sent cannot be edited", async () => {
    for (const status of ["sending", "sent", "skipped"] as const) {
      const { deps, mem } = setup({ ...base(), digests: [digestRow({ status, week_start: "2026-10-19" })] });
      expect(await updateDigest(deps, "d1", { subject: "New", intro: "", articleIds: ["a1"] })).toMatchObject({ ok: false });
      expect(mem.digests[0].subject).not.toBe("New");
    }
  });

  it("unapprove returns an approved digest to draft; nothing else", async () => {
    const { deps, mem } = setup(base());
    expect((await unapproveDigest(deps, "d1")).ok).toBe(false); // still a draft
    await approveDigest(deps, "d1");
    expect(await unapproveDigest(deps, "d1")).toEqual({ ok: true });
    expect(mem.digests[0]).toMatchObject({ status: "draft", approved_by: null });
    expect(mem.logs.map((l) => l.action)).toEqual(["approve", "unapprove"]);
  });

  it("counts recipients including the distribution list", async () => {
    const { deps } = setup({ recipients: ["a@example.com", "b@example.com"] }, { dl: "all@example.com" });
    expect(await recipientCount(deps)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------
describe("send guard", () => {
  const seed = (digest = approved(), recipients = ["a@example.com", "b@example.com"]) => ({ articles: [article("a1")], digests: [digest], recipients });

  it("sends an approved digest once, then marks it sent with the time and count", async () => {
    const s = sendSetup(seed());
    const r = await sendDigestNow(s.send, "d1");
    expect(r).toMatchObject({ ok: true, recipients: 2, batches: 1 });
    expect(s.mem.digests[0]).toMatchObject({ status: "sent", sent_at: NOW.toISOString(), recipient_count: 2 });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].bcc).toEqual(["a@example.com", "b@example.com"]);
    expect(s.sent[0].to).toEqual(["Company Newsroom <newsroom@example.com>"]);
    expect(s.mem.logs.map((l) => l.action)).toEqual(["send_started", "send_batch", "sent"]);
  });

  it("never sends a draft", async () => {
    const s = sendSetup(seed(approved({ status: "draft", approved_by: null, approved_at: null })));
    const r = await sendDigestNow(s.send, "d1");
    expect(r).toMatchObject({ ok: false, status: "draft" });
    expect(s.provider.send).not.toHaveBeenCalled();
  });

  it.each(["draft", "sending", "failed", "skipped"] as const)("never sends a digest that is %s", async (status) => {
    const s = sendSetup(seed(approved({ status })));
    expect((await sendDigestNow(s.send, "d1")).ok).toBe(false);
    expect(s.provider.send).not.toHaveBeenCalled();
  });

  it("never sends a sent digest again", async () => {
    const s = sendSetup(seed());
    await sendDigestNow(s.send, "d1");
    const again = await sendDigestNow(s.send, "d1");
    expect(again).toMatchObject({ ok: false, status: "sent", error: expect.stringContaining("already been sent") });
    expect(s.sent).toHaveLength(1);
  });

  it("with two workers at once (cron and a click), exactly one sends", async () => {
    const s = sendSetup(seed());
    const results = await Promise.all([sendDigestNow(s.send, "d1"), sendDigestNow(s.send, "d1"), runScheduledSend(s.remind)]);
    expect(s.sent).toHaveLength(1);
    expect(results.filter((r) => ("ok" in r ? r.ok : r.action === "sent"))).toHaveLength(1);
    expect(s.mem.digests[0].status).toBe("sent");
    expect(s.mem.logs.filter((l) => l.action === "send_started")).toHaveLength(1);
  });

  it("the claim is the atomic approved -> sending update: a second claim finds no approved row", async () => {
    const s = sendSetup(seed());
    const first = await s.mem.store.update("d1", { status: "sending" }, ["approved"]);
    const second = await s.mem.store.update("d1", { status: "sending" }, ["approved"]);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("does not send, or touch the status, when the provider is none", async () => {
    const s = sendSetup(seed(), {}, createNoneProvider());
    const r = await sendDigestNow(s.send, "d1");
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("EMAIL_PROVIDER=none") });
    expect(s.mem.digests[0].status).toBe("approved");
    expect(s.mem.logs).toEqual([]);
  });

  it("refuses to send to nobody, without claiming", async () => {
    const s = sendSetup(seed(approved(), []));
    expect(await sendDigestNow(s.send, "d1")).toMatchObject({ ok: false, error: "There are no recipients." });
    expect(s.mem.digests[0].status).toBe("approved");
  });

  it("sends in BCC batches of 50, and one message to the distribution list", async () => {
    const many = Array.from({ length: 120 }, (_, i) => `user${i}@example.com`);
    const s = sendSetup(seed(approved(), many), { dl: "everyone@example.com" });
    const r = await sendDigestNow(s.send, "d1");
    expect(BATCH_SIZE).toBe(50);
    expect(r).toMatchObject({ ok: true, recipients: 121, batches: 4 });
    expect(s.sent.map((m) => [m.to.length, m.bcc?.length ?? 0])).toEqual([[1, 0], [1, 50], [1, 50], [1, 20]]);
    expect(s.sent[0].to).toEqual(["everyone@example.com"]);
    expect(s.mem.logs.filter((l) => l.action === "send_batch")).toHaveLength(4);
  });

  it("logs each batch without ever writing an address", async () => {
    const many = Array.from({ length: 60 }, (_, i) => `person${i}@readers.test`);
    const s = sendSetup(seed(approved(), many), { dl: "list@readers.test" });
    await sendDigestNow(s.send, "d1");
    const logged = JSON.stringify(s.mem.logs);
    expect(logged).not.toContain("readers.test"); // the actor (the admin) is logged; no recipient is
    expect(s.mem.logs.filter((l) => l.action === "send_batch").map((l) => l.detail)).toEqual([
      { batch: 1, of: 3, size: 1, ok: true },
      { batch: 2, of: 3, size: 50, ok: true },
      { batch: 3, of: 3, size: 10, ok: true },
    ]);
  });

  it("marks the digest failed with the reason, saying how many batches had gone out, and does not resend it", async () => {
    const many = Array.from({ length: 70 }, (_, i) => `p${i}@example.com`);
    let calls = 0;
    const s = sendSetup(seed(approved(), many), {}, {
      send: vi.fn(async () => {
        if (++calls === 2) throw new MailError("SMTP AUTH is disabled for this mailbox; ask IT to enable it, or use Download .eml", "auth");
      }),
    });
    const r = await sendDigestNow(s.send, "d1");
    expect(r).toMatchObject({ ok: false, status: "failed", error: expect.stringContaining("SMTP AUTH is disabled") });
    expect(r.ok === false && r.error).toContain("1 of 2 batches had already been sent");
    expect(s.mem.digests[0]).toMatchObject({ status: "failed", error: expect.stringContaining("SMTP AUTH") });
    expect(s.mem.logs.map((l) => l.action)).toContain("send_failed");
    expect(await sendDigestNow(s.send, "d1")).toMatchObject({ ok: false, status: "failed" });
    expect(calls).toBe(2);
  });

  it("a failed digest can be fixed (edit -> draft), approved again and sent", async () => {
    const s = sendSetup(seed(approved({ status: "failed", error: "boom" })));
    expect(await updateDigest(s.send, "d1", { subject: "S", intro: "", articleIds: ["a1"] })).toMatchObject({ ok: true });
    expect(s.mem.digests[0]).toMatchObject({ status: "draft", error: null });
    await approveDigest(s.send, "d1");
    expect(await sendDigestNow(s.send, "d1")).toMatchObject({ ok: true });
  });

  it("embeds images only when the provider can carry them", async () => {
    const s = sendSetup(seed(), {}, { supportsInlineImages: false });
    await sendDigestNow(s.send, "d1");
    expect(s.buildMail).toHaveBeenCalledWith(expect.anything(), expect.anything(), { inlineImages: false });
  });
});

describe("send test", () => {
  it("goes only to the admin's own address, never to the list, and leaves the status alone", async () => {
    const s = sendSetup({ articles: [article("a1")], digests: [approved()], recipients: ["a@example.com", "b@example.com"] }, { dl: "all@example.com" });
    expect(await sendTestToAdmin(s.send, "d1")).toEqual({ ok: true });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].to).toEqual([ADMIN]);
    expect(s.sent[0].bcc).toBeUndefined();
    expect(s.sent[0].subject).toBe("[TEST] Company Newsroom weekly: Headline a1");
    expect(s.mem.digests[0].status).toBe("approved");
    expect(s.mem.logs).toEqual([{ digestId: "d1", action: "test_sent", actor: ADMIN, detail: undefined }]);
  });

  it("reports a mail error", async () => {
    const s = sendSetup({ articles: [article("a1")], digests: [digestRow({ week_start: "2026-10-19" })] }, {}, createNoneProvider());
    expect(await sendTestToAdmin(s.send, "d1")).toMatchObject({ ok: false, error: expect.stringContaining("EMAIL_PROVIDER=none") });
  });
});

// ---------------------------------------------------------------------------
// The scheduled send
// ---------------------------------------------------------------------------
describe("scheduled send (Monday cron)", () => {
  it("does nothing when there is no digest for the week", async () => {
    const s = sendSetup({ articles: [article("a1")], recipients: ["a@example.com"] });
    expect(await runScheduledSend(s.remind)).toEqual({ action: "none" });
    expect(s.sent).toEqual([]);
  });

  it("sends an approved digest", async () => {
    const s = sendSetup({ articles: [article("a1")], digests: [approved()], recipients: ["a@example.com"] });
    expect(await runScheduledSend(s.remind)).toEqual({ action: "sent", batches: 1, recipients: 1 });
    expect(s.mem.logs.find((l) => l.action === "send_started")?.actor).toBe("cron");
  });

  it("does NOT send a draft: it emails the admins a reminder instead, once", async () => {
    const s = sendSetup({ articles: [article("a1")], digests: [digestRow({ week_start: "2026-10-19" })], recipients: ["a@example.com"] });
    expect(await runScheduledSend(s.remind)).toEqual({ action: "reminded" });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].subject).toBe("Digest waiting for your approval");
    expect(s.sent[0].bcc).toEqual([ADMIN, "second@example.com"]);
    expect(s.sent[0].text).toContain("https://newsroom.example.com/admin/digest");
    expect(s.sent[0].bcc).not.toContain("a@example.com"); // the readers get nothing
    expect(s.mem.digests[0].status).toBe("draft");

    expect(await runScheduledSend(s.remind)).toEqual({ action: "already_reminded" });
    expect(s.sent).toHaveLength(1);
  });

  it("an approved digest that is edited before the cron runs is a draft again, so it is not sent", async () => {
    const s = sendSetup({ articles: [article("a1"), article("a2")], digests: [approved({ article_ids: ["a1"] })], recipients: ["a@example.com"] });
    await updateDigest(s.send, "d1", { subject: "Changed", intro: "", articleIds: ["a1", "a2"] });
    expect((await runScheduledSend(s.remind)).action).toBe("reminded");
    expect(s.sent.every((m) => m.subject === "Digest waiting for your approval")).toBe(true);
  });

  it("tries the reminder again next time if it could not be sent", async () => {
    const s = sendSetup({ articles: [article("a1")], digests: [digestRow({ week_start: "2026-10-19" })], recipients: ["a@example.com"] }, {}, createNoneProvider());
    expect(await runScheduledSend(s.remind)).toMatchObject({ action: "reminder_failed" });
    expect(s.mem.digests[0].reminder_sent_at).toBeNull();
    expect(s.mem.logs.map((l) => l.action)).toContain("reminder_failed");
  });

  it.each(["sent", "sending", "failed", "skipped"] as const)("does nothing for a digest that is %s", async (status) => {
    const s = sendSetup({ articles: [article("a1")], digests: [digestRow({ week_start: "2026-10-19", status })], recipients: ["a@example.com"] });
    expect(await runScheduledSend(s.remind)).toEqual({ action: "not_sent", status });
    expect(s.sent).toEqual([]);
  });

  it("does not send last week's digest", async () => {
    const s = sendSetup({ articles: [article("a1")], digests: [approved({ week_start: "2026-10-12" })], recipients: ["a@example.com"] });
    expect(await runScheduledSend(s.remind)).toEqual({ action: "none" });
    expect(s.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------
describe("recipients", () => {
  it("parses a pasted list", () => {
    const { valid, invalid } = parseRecipients('A@Example.com, b@example.com;\nC <c@example.com>  not-an-email  a@example.com');
    expect(valid).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
    expect(invalid).toEqual(["not-an-email"]);
  });

  it("adds, counts duplicates and logs only counts", async () => {
    const mem = createMemoryStore({ recipients: ["a@example.com"] });
    const rd = { recipients: mem.recipientStore, adminEmail: async () => ADMIN, log: mem.store.log };
    expect(await addRecipients(rd, "a@example.com, b@example.com, junk")).toEqual({ ok: true, added: 1, duplicates: 1, invalid: 1 });
    expect(JSON.stringify(mem.logs)).not.toContain("b@example.com"); // counts only
    expect(await addRecipients(rd, "junk")).toMatchObject({ ok: false });
  });

  it("deactivated recipients are not sent to", async () => {
    const mem = createMemoryStore({ recipients: ["a@example.com", "b@example.com"] });
    const rd = { recipients: mem.recipientStore, adminEmail: async () => ADMIN, log: mem.store.log };
    await setRecipientActive(rd, "r0", false);
    expect(await mem.store.activeRecipients()).toEqual(["b@example.com"]);
    await removeRecipient(rd, "r1");
    expect(await mem.store.activeRecipients()).toEqual([]);
  });
});
