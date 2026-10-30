import { describe, expect, it, vi } from "vitest";
import { createNoneProvider } from "@/lib/mail";
import { createGraphProvider } from "@/lib/mail/graph";
import { createSmtpProvider } from "@/lib/mail/smtp";
import { cleanMessageId, type MailMessage, type MailProvider, type MailReceipt } from "@/lib/mail/types";
import { article, createMemoryStore, digestRow } from "./memory-store";
import { markDigestFailed, retryDigest, sendDigestNow, STUCK_AFTER_MS, stuckMinutes, updateDigest, type DigestDeps, type SendDeps } from "./service";

// BE-03: a digest stuck in "sending" can be marked failed (after 15 minutes) and a failed one retried; the provider's
// message id is logged when a send succeeds.

const ADMIN = "editor@example.com";
const NOW = new Date("2026-10-19T09:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

function setup(
  digests: ReturnType<typeof digestRow>[],
  o: { admin?: string | null; recipients?: string[]; provider?: Partial<MailProvider>; receipt?: (n: number) => MailReceipt | void } = {},
) {
  const mem = createMemoryStore({ articles: [article("a1")], digests, recipients: o.recipients ?? ["one@example.com", "two@example.com"] });
  const deps: DigestDeps = { store: mem.store, adminEmail: async () => (o.admin === undefined ? ADMIN : o.admin), now: () => NOW, maxStories: 6, distributionList: null };
  const sent: MailMessage[] = [];
  const provider: MailProvider = {
    name: "smtp",
    supportsInlineImages: true,
    send: vi.fn(async (m: MailMessage) => {
      sent.push(m);
      return o.receipt?.(sent.length);
    }),
    ...o.provider,
  };
  const send: SendDeps = { ...deps, provider, buildMail: async () => ({ subject: "S", html: "<p>h</p>", text: "t" }), from: "Newsroom <newsroom@example.com>" };
  return { mem, deps, send, sent, provider };
}

const sending = (minutes: number, over = {}) =>
  digestRow({ status: "sending", approved_by: ADMIN, week_start: "2026-10-19", updated_at: minutesAgo(minutes), ...over });
const failed = (over = {}) => digestRow({ status: "failed", approved_by: ADMIN, week_start: "2026-10-19", error: "SMTP AUTH is disabled for this mailbox", ...over });

describe("stuckMinutes", () => {
  it("is null while a digest is sending for 15 minutes or less", () => {
    expect(stuckMinutes(sending(1), NOW)).toBeNull();
    expect(stuckMinutes(sending(15), NOW)).toBeNull();
    expect(STUCK_AFTER_MS).toBe(15 * 60_000);
  });

  it("is the number of minutes once it has been sending longer than that", () => {
    expect(stuckMinutes(sending(16), NOW)).toBe(16);
    expect(stuckMinutes(sending(95), NOW)).toBe(95);
  });

  it("is null for every other status, however old", () => {
    for (const status of ["draft", "approved", "sent", "failed", "skipped"] as const) {
      expect(stuckMinutes({ status, updated_at: minutesAgo(600) }, NOW)).toBeNull();
    }
  });
});

describe("markDigestFailed", () => {
  it("is for admins only, and changes nothing otherwise", async () => {
    const s = setup([sending(60)], { admin: null });
    expect(await markDigestFailed(s.deps, "d1")).toEqual({ ok: false, error: "Not authorised." });
    expect(s.mem.digests[0].status).toBe("sending");
    expect(s.mem.logs).toEqual([]);
  });

  it("refuses a digest that has been sending for less than 15 minutes: that send may still be running", async () => {
    const s = setup([sending(5)]);
    const r = await markDigestFailed(s.deps, "d1");
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && r.error).toMatch(/less than 15 minutes/);
    expect(s.mem.digests[0].status).toBe("sending");
  });

  it("marks a stuck digest as failed, says who and how long, and logs it", async () => {
    const s = setup([sending(42)]);
    expect(await markDigestFailed(s.deps, "d1")).toEqual({ ok: true, minutes: 42 });
    expect(s.mem.digests[0]).toMatchObject({ status: "failed" });
    expect(s.mem.digests[0].error).toContain(ADMIN);
    expect(s.mem.digests[0].error).toContain("42 minutes");
    expect(s.mem.digests[0].error).toMatch(/check before retrying/);
    expect(s.mem.logs).toEqual([{ digestId: "d1", action: "marked_failed", actor: ADMIN, detail: { minutes: 42, previous_status: "sending" } }]);
  });

  it("refuses every other status", async () => {
    for (const status of ["draft", "approved", "sent", "failed"] as const) {
      const s = setup([digestRow({ status, week_start: "2026-10-19", updated_at: minutesAgo(600) })]);
      const r = await markDigestFailed(s.deps, "d1");
      expect(r.ok, status).toBe(false);
      expect(s.mem.digests[0].status).toBe(status);
    }
  });

  it("a second click does nothing more (the update is conditional on 'sending')", async () => {
    const s = setup([sending(30)]);
    const [a, b] = await Promise.all([markDigestFailed(s.deps, "d1"), markDigestFailed(s.deps, "d1")]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(s.mem.logs.filter((l) => l.action === "marked_failed")).toHaveLength(1);
  });

  it("reports an unknown digest", async () => {
    expect(await markDigestFailed(setup([]).deps, "nope")).toEqual({ ok: false, error: "Digest not found." });
  });

  it("afterwards the digest can be edited again, like any failed digest", async () => {
    const s = setup([sending(30)]);
    await markDigestFailed(s.deps, "d1");
    expect(await updateDigest(s.deps, "d1", { subject: "New subject", intro: "", articleIds: ["a1"] })).toMatchObject({ ok: true, changed: true });
    expect(s.mem.digests[0]).toMatchObject({ status: "draft", error: null });
  });
});

describe("retryDigest", () => {
  it("is for admins only", async () => {
    const s = setup([failed()], { admin: null });
    expect(await retryDigest(s.send, "d1")).toEqual({ ok: false, error: "Not authorised." });
    expect(s.sent).toEqual([]);
    expect(s.mem.digests[0].status).toBe("failed");
  });

  it("sends a failed digest again: approved, then sent, with the retry in the log", async () => {
    const s = setup([failed()]);
    const r = await retryDigest(s.send, "d1");
    expect(r).toMatchObject({ ok: true, status: "sent", recipients: 2 });
    expect(s.sent).toHaveLength(1);
    expect(s.mem.digests[0]).toMatchObject({ status: "sent", error: null, approved_by: ADMIN, recipient_count: 2 });
    const actions = s.mem.logs.map((l) => l.action);
    expect(actions).toEqual(["retry", "send_started", "send_batch", "sent"]);
    expect(s.mem.logs[0].detail).toEqual({ previous_error: "SMTP AUTH is disabled for this mailbox" });
  });

  it("ends up failed again, with the new reason, when the retry fails too", async () => {
    const s = setup([failed()], { provider: { send: vi.fn(async () => Promise.reject(new Error("Connection refused"))) } });
    const r = await retryDigest(s.send, "d1");
    expect(r).toMatchObject({ ok: false, status: "failed" });
    expect(s.mem.digests[0]).toMatchObject({ status: "failed", error: expect.stringContaining("Connection refused") });
    expect(s.mem.logs.map((l) => l.action)).toEqual(["retry", "send_started", "send_batch", "send_failed"]);
  });

  it("leaves the digest failed when email is switched off or nobody is on the list", async () => {
    const off = setup([failed()], { provider: createNoneProvider() });
    expect(await retryDigest(off.send, "d1")).toMatchObject({ ok: false, error: expect.stringContaining("EMAIL_PROVIDER=none") });
    expect(off.mem.digests[0].status).toBe("failed");
    expect(off.mem.logs).toEqual([]);

    const nobody = setup([failed()], { recipients: [] });
    expect(await retryDigest(nobody.send, "d1")).toMatchObject({ ok: false, error: "There are no recipients." });
    expect(nobody.mem.digests[0].status).toBe("failed");
  });

  it("only retries a failed digest", async () => {
    for (const status of ["draft", "approved", "sending", "sent", "skipped"] as const) {
      const s = setup([digestRow({ status, week_start: "2026-10-19" })]);
      const r = await retryDigest(s.send, "d1");
      expect(r.ok, status).toBe(false);
      expect(s.sent, status).toEqual([]);
      expect(s.mem.digests[0].status).toBe(status);
    }
  });

  it("two clicks send once", async () => {
    const s = setup([failed()]);
    const results = await Promise.all([retryDigest(s.send, "d1"), retryDigest(s.send, "d1")]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(s.sent).toHaveLength(1);
  });

  it("a marked-failed stuck digest can be retried straight away", async () => {
    const s = setup([sending(30)]);
    expect((await markDigestFailed(s.deps, "d1")).ok).toBe(true);
    expect(await retryDigest(s.send, "d1")).toMatchObject({ ok: true, status: "sent" });
  });
});

describe("an approved digest that has a send_failed entry in its log can be sent again from the UI", () => {
  const approvedAfterFailure = () => digestRow({ status: "approved", approved_by: ADMIN, week_start: "2026-10-19", error: null });

  it("Send now works on it, and the last failure is available to show why it is waiting", async () => {
    const s = setup([approvedAfterFailure()]);
    await s.mem.store.log("d1", "send_failed", "cron", { error: "SMTP AUTH is disabled for this mailbox", batches_sent: 0, of: 1 });
    expect(await s.mem.store.lastFailure?.("d1")).toMatchObject({ error: "SMTP AUTH is disabled for this mailbox" });
    expect(await sendDigestNow(s.send, "d1")).toMatchObject({ ok: true, status: "sent" });
    expect(s.sent).toHaveLength(1);
  });

  it("lastFailure is null for a digest that never failed", async () => {
    const s = setup([approvedAfterFailure()]);
    expect(await s.mem.store.lastFailure?.("d1")).toBeNull();
  });
});

describe("the provider's message id is logged when a send succeeds", () => {
  const approved = () => digestRow({ status: "approved", approved_by: ADMIN, week_start: "2026-10-19" });

  it("records one id per batch and the full list on 'sent'", async () => {
    const recipients = Array.from({ length: 120 }, (_, i) => `person${i}@example.com`); // 3 batches of 50
    const s = setup([approved()], { recipients, receipt: (n) => ({ messageId: `msg-${n}` }) });
    expect(await sendDigestNow(s.send, "d1")).toMatchObject({ ok: true, batches: 3 });
    const batches = s.mem.logs.filter((l) => l.action === "send_batch");
    expect(batches.map((l) => l.detail?.message_id)).toEqual(["msg-1", "msg-2", "msg-3"]);
    expect(s.mem.logs.find((l) => l.action === "sent")?.detail).toMatchObject({ recipients: 120, batches: 3, message_ids: ["msg-1", "msg-2", "msg-3"] });
  });

  it("cleans the id: no angle brackets", async () => {
    const s = setup([approved()], { receipt: () => ({ messageId: "<abc123@mail.example.com>" }) });
    await sendDigestNow(s.send, "d1");
    expect(s.mem.logs.find((l) => l.action === "send_batch")?.detail?.message_id).toBe("abc123@mail.example.com");
  });

  it("logs nothing extra when the provider gives no id, and the send still works", async () => {
    const s = setup([approved()]);
    expect(await sendDigestNow(s.send, "d1")).toMatchObject({ ok: true });
    expect(s.mem.logs.find((l) => l.action === "send_batch")?.detail).not.toHaveProperty("message_id");
    expect(s.mem.logs.find((l) => l.action === "sent")?.detail).not.toHaveProperty("message_ids");
  });

  it("never puts a recipient address in the log", async () => {
    const s = setup([approved()], { receipt: () => ({ messageId: "msg-1" }) });
    await sendDigestNow(s.send, "d1");
    expect(JSON.stringify(s.mem.logs)).not.toMatch(/one@example\.com|two@example\.com/);
  });

  it("a failed batch has no id, and the earlier ones keep theirs in the log", async () => {
    const recipients = Array.from({ length: 60 }, (_, i) => `p${i}@example.com`); // 2 batches
    let n = 0;
    const s = setup([approved()], {
      recipients,
      provider: {
        send: vi.fn(async () => {
          if (++n === 2) throw new Error("boom");
          return { messageId: "first" };
        }),
      },
    });
    expect(await sendDigestNow(s.send, "d1")).toMatchObject({ ok: false, status: "failed" });
    const batches = s.mem.logs.filter((l) => l.action === "send_batch");
    expect(batches[0].detail).toMatchObject({ ok: true, message_id: "first" });
    expect(batches[1].detail).toMatchObject({ ok: false });
    expect(batches[1].detail).not.toHaveProperty("message_id");
  });
});

describe("the providers hand back their id", () => {
  const message: MailMessage = { from: "a@example.com", to: ["b@example.com"], subject: "S", text: "t", html: "<p>t</p>" };

  it("cleanMessageId trims, unwraps and caps", () => {
    expect(cleanMessageId(" <id@host> ")).toBe("id@host");
    expect(cleanMessageId("")).toBeNull();
    expect(cleanMessageId(undefined)).toBeNull();
    expect(cleanMessageId("x".repeat(500))?.length).toBe(200);
  });

  it("SMTP: the messageId nodemailer reports", async () => {
    const provider = createSmtpProvider({ host: "smtp.example.com", port: 587, user: "u", pass: "p", from: "a@example.com" }, () => ({
      sendMail: async () => ({ messageId: "<8f0c@smtp.example.com>", accepted: ["b@example.com"] }),
    }));
    expect(await provider.send(message)).toEqual({ messageId: "8f0c@smtp.example.com" });
  });

  it("SMTP: an empty receipt when the server gave no id", async () => {
    const provider = createSmtpProvider({ host: "smtp.example.com", port: 587, user: "u", pass: "p", from: "a@example.com" }, () => ({ sendMail: async () => ({}) }));
    expect(await provider.send(message)).toEqual({});
  });

  it("Graph: the request id of the 202 response", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      if (String(url).includes("oauth2")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      return new Response(null, { status: 202, headers: { "request-id": "req-1234" } });
    }) as unknown as typeof fetch;
    const provider = createGraphProvider({ tenantId: "t", clientId: "c", clientSecret: "s", from: "a@example.com" }, fetchImpl);
    expect(await provider.send(message)).toEqual({ messageId: "req-1234" });
  });
});
