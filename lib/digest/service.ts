// Digest logic: drafting, editing, approval, sending. Every database and mail call goes through
// injected dependencies, so the rules (who may do what, when a digest may be sent, who wins a race)
// are tested without a database or a mail server. No secret and no recipient address is ever logged.
import { z } from "zod";
import { DIGEST_STUCK_MINUTES } from "@/lib/config";
import { cleanMessageId, MAIL_DISABLED_MESSAGE, MailError, type MailMessage, type MailProvider } from "@/lib/mail/types";
import { digestSubject, selectStories } from "./select";
import { DEFAULT_INTRO, DEFAULT_INTRO_WITH_EMPLOYEES, SUBJECT_MAX, type DigestAction, type DigestArticle, type DigestRow, type DigestStatus } from "./types";
import { weekStart, windowStart } from "./week";

export const BATCH_SIZE = 50;
export const MAX_STORIES_LIMIT = 12;
export const INTRO_MAX = 600;
export const NO_CANDIDATES = "No new published stories in the last 7 days, so there is no digest this week.";

export type NewDigest = Omit<DigestRow, "id" | "created_at" | "updated_at">;

export interface DigestStore {
  getByWeek(week: string): Promise<DigestRow | null>;
  getById(id: string): Promise<DigestRow | null>;
  /** The digest to show in the admin: this week's, else the most recent. */
  current(week: string): Promise<DigestRow | null>;
  /** Insert unless a digest for this week_start exists (never a duplicate). Null if it exists. */
  insertIfAbsent(row: NewDigest): Promise<DigestRow | null>;
  /** Atomic conditional update: applies only while the status is one of `from`. Null if it did not apply. */
  update(id: string, patch: Partial<NewDigest>, from: DigestStatus[], opts?: { reminderUnsent?: boolean }): Promise<DigestRow | null>;
  /** Article ids already used by digests of earlier weeks that were approved, being sent, or sent. */
  usedArticleIds(beforeWeek: string): Promise<Set<string>>;
  /** Published articles with published_at >= sinceIso, newest first. */
  candidates(sinceIso: string): Promise<DigestArticle[]>;
  /** Published articles among `ids`, in the order of `ids`. */
  articles(ids: string[]): Promise<DigestArticle[]>;
  activeRecipients(): Promise<string[]>;
  log(digestId: string | null, action: DigestAction, actor: string, detail?: Record<string, unknown>): Promise<void>;
  /** The latest failed send attempt of a digest (from the log), for showing why an approved digest is waiting again. */
  lastFailure?(digestId: string): Promise<{ at: string; error: string } | null>;
}

export type DigestDeps = {
  store: DigestStore;
  /** The signed-in admin's email, or null. Admin functions check this first. */
  adminEmail: () => Promise<string | null>;
  now: () => Date;
  maxStories: number;
  /** DIGEST_TO: one distribution list, sent as a single message. */
  distributionList: string | null;
};

const NOT_ADMIN = "Not authorised.";
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

async function asAdmin(deps: DigestDeps): Promise<string | null> {
  return deps.adminEmail();
}

/** Number of addresses a send would go to: active recipients plus the distribution list, if any. */
export async function recipientCount(deps: Pick<DigestDeps, "store" | "distributionList">): Promise<number> {
  const active = await deps.store.activeRecipients();
  return active.length + (deps.distributionList ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------

export type DraftResult =
  | { kind: "created"; digest: DigestRow }
  | { kind: "exists"; digest: DigestRow }
  | { kind: "skipped"; digest: DigestRow; reason: string };

/** Builds this week's draft (cron, or the admin button). One digest per week_start; never a duplicate. */
export async function createDraft(deps: DigestDeps, actor: string): Promise<DraftResult> {
  const { store } = deps;
  const week = weekStart(deps.now());

  const existing = await store.getByWeek(week);
  // A draft the admin may be editing, or a digest already approved or sent, is left exactly as it is.
  if (existing && existing.status !== "skipped") return { kind: "exists", digest: existing };

  const used = await store.usedArticleIds(week);
  const candidates = (await store.candidates(windowStart(deps.now()).toISOString())).filter((a) => !used.has(a.id));
  const picked = selectStories(candidates, Math.min(deps.maxStories, MAX_STORIES_LIMIT));

  const base = { week_start: week, approved_by: null, approved_at: null, sent_at: null, recipient_count: null, reminder_sent_at: null };
  const row: NewDigest =
    picked.length === 0
      ? { ...base, status: "skipped", subject: "", intro: "", lead_article_id: null, article_ids: [], error: NO_CANDIDATES }
      : {
          ...base,
          status: "draft",
          subject: digestSubject(picked[0].headline),
          intro: picked.some((a) => a.origin === "employee") ? DEFAULT_INTRO_WITH_EMPLOYEES : DEFAULT_INTRO,
          lead_article_id: picked[0].id,
          article_ids: picked.map((a) => a.id),
          error: null,
        };

  // A skipped week is re-evaluated in place; a new week is inserted (the unique week_start decides a race).
  const saved = existing ? await store.update(existing.id, row, ["skipped"]) : await store.insertIfAbsent(row);
  if (!saved) {
    const winner = await store.getByWeek(week);
    if (winner) return { kind: "exists", digest: winner };
    throw new Error("Could not save the digest draft.");
  }

  if (saved.status === "skipped") {
    await store.log(saved.id, "draft_skipped", actor, { reason: "no candidates" });
    return { kind: "skipped", digest: saved, reason: NO_CANDIDATES };
  }
  await store.log(saved.id, "draft_created", actor, { stories: saved.article_ids.length });
  return { kind: "created", digest: saved };
}

/** The admin button "Create this week's draft". */
export async function adminCreateDraft(deps: DigestDeps): Promise<Result<{ draft: DraftResult }>> {
  const admin = await asAdmin(deps);
  if (!admin) return { ok: false, error: NOT_ADMIN };
  try {
    return { ok: true, draft: await createDraft(deps, admin) };
  } catch (err) {
    return { ok: false, error: message(err) };
  }
}

// ---------------------------------------------------------------------------
// Edit, approve, unapprove
// ---------------------------------------------------------------------------

const editSchema = z.object({
  subject: z.string().trim().min(1, "Subject is required").max(SUBJECT_MAX, `Subject is too long (max ${SUBJECT_MAX})`),
  intro: z.string().trim().max(INTRO_MAX, `Intro is too long (max ${INTRO_MAX})`),
  articleIds: z.array(z.string().min(1)).min(1, "Include at least one story").max(MAX_STORIES_LIMIT, `At most ${MAX_STORIES_LIMIT} stories`),
});

export type DigestEdit = z.input<typeof editSchema>;

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Save the subject, intro and story list (the first story is the lead). Any change to an approved digest
 * puts it back to 'draft', so it has to be approved again; the status check is part of the update, so an
 * edit cannot slip in once sending has started.
 */
export async function updateDigest(deps: DigestDeps, id: string, input: DigestEdit): Promise<Result<{ approvalReset: boolean; changed: boolean }>> {
  const admin = await asAdmin(deps);
  if (!admin) return { ok: false, error: NOT_ADMIN };

  const parsed = editSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  const { subject, intro } = parsed.data;
  const articleIds = [...new Set(parsed.data.articleIds)];

  const row = await deps.store.getById(id);
  if (!row) return { ok: false, error: "Digest not found." };
  if (!["draft", "approved", "failed"].includes(row.status)) {
    return { ok: false, error: `A digest that is ${row.status} cannot be edited.` };
  }

  const found = await deps.store.articles(articleIds);
  if (found.length !== articleIds.length) return { ok: false, error: "One of the stories is not published (any more)." };

  const wasApproved = row.status === "approved"; // read before the update, which changes it
  const unchanged = row.subject === subject && row.intro === intro && sameList(row.article_ids, articleIds);
  if (unchanged) return { ok: true, approvalReset: false, changed: false };

  const saved = await deps.store.update(
    id,
    { subject, intro, lead_article_id: articleIds[0], article_ids: articleIds, status: "draft", approved_by: null, approved_at: null, error: null },
    ["draft", "approved", "failed"],
  );
  if (!saved) return { ok: false, error: "This digest can no longer be edited: it is being sent or has been sent." };

  const approvalReset = wasApproved;
  await deps.store.log(id, "edit", admin, { stories: articleIds.length });
  if (approvalReset) await deps.store.log(id, "approval_reset", admin, { was: "approved" });
  return { ok: true, approvalReset, changed: true };
}

export async function approveDigest(deps: DigestDeps, id: string): Promise<Result> {
  const admin = await asAdmin(deps);
  if (!admin) return { ok: false, error: NOT_ADMIN };

  const row = await deps.store.getById(id);
  if (!row) return { ok: false, error: "Digest not found." };
  if (row.status !== "draft") return { ok: false, error: `Only a draft can be approved (this one is ${row.status}).` };
  if (row.article_ids.length === 0) return { ok: false, error: "The digest has no stories." };
  if ((await recipientCount(deps)) === 0) return { ok: false, error: "Add at least one recipient (or set DIGEST_TO) before approving." };

  const saved = await deps.store.update(id, { status: "approved", approved_by: admin, approved_at: deps.now().toISOString(), error: null }, ["draft"]);
  if (!saved) return { ok: false, error: "The digest changed while you were approving it. Reload and check it." };
  await deps.store.log(id, "approve", admin);
  return { ok: true };
}

export async function unapproveDigest(deps: DigestDeps, id: string): Promise<Result> {
  const admin = await asAdmin(deps);
  if (!admin) return { ok: false, error: NOT_ADMIN };

  const saved = await deps.store.update(id, { status: "draft", approved_by: null, approved_at: null }, ["approved"]);
  if (!saved) return { ok: false, error: "Only an approved digest that has not started sending can be unapproved." };
  await deps.store.log(id, "unapprove", admin);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** What the sender needs to build a message from a stored digest. */
export type MailBuilder = (digest: DigestRow, articles: DigestArticle[], opts: { inlineImages: boolean }) => Promise<Pick<MailMessage, "subject" | "html" | "text" | "inlineImages">>;

export type SendDeps = DigestDeps & {
  provider: MailProvider;
  buildMail: MailBuilder;
  /** Sender address (MAIL_FROM). The To of BCC batches. */
  from: string;
};

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export type SendResult = Result<{ batches: number; recipients: number }> & { status?: DigestStatus };

/**
 * Sends an approved digest, once. The only way in is the atomic update approved -> sending: of several
 * workers (cron, "Send now", a double click) exactly one gets the row, the others stop. A draft is never
 * sent; a sent digest is never sent again.
 */
async function sendClaimed(deps: SendDeps, id: string, actor: string): Promise<SendResult> {
  const { store, provider } = deps;

  // With EMAIL_PROVIDER=none nothing can be sent, so do not move the digest out of "approved" for nothing.
  if (provider.name === "none") return { ok: false, error: MAIL_DISABLED_MESSAGE };

  const row = await store.getById(id);
  if (!row) return { ok: false, error: "Digest not found." };
  if (row.status === "sent") return { ok: false, error: "This digest has already been sent.", status: "sent" };
  if (row.status !== "approved") return { ok: false, error: `Only an approved digest is sent (this one is ${row.status}).`, status: row.status };

  const recipients = await store.activeRecipients();
  const total = recipients.length + (deps.distributionList ? 1 : 0);
  if (total === 0) return { ok: false, error: "There are no recipients." };

  // The race is decided here, in the database, not by the checks above.
  const claimed = await store.update(id, { status: "sending", error: null }, ["approved"]);
  if (!claimed) return { ok: false, error: "This digest is already being sent, or is no longer approved." };
  await store.log(id, "send_started", actor, { recipients: total });

  const batches: { to: string[]; bcc?: string[] }[] = [];
  if (deps.distributionList) batches.push({ to: [deps.distributionList] });
  for (const group of chunk(recipients, BATCH_SIZE)) batches.push({ to: [deps.from], bcc: group });

  let sentBatches = 0;
  const messageIds: string[] = [];
  try {
    const articles = await store.articles(claimed.article_ids);
    if (articles.length === 0) throw new Error("None of the digest's stories is published any more.");
    const mail = await deps.buildMail(claimed, articles, { inlineImages: provider.supportsInlineImages });

    for (const [i, batch] of batches.entries()) {
      let messageId: string | null = null;
      try {
        const receipt = await provider.send({ from: deps.from, to: batch.to, bcc: batch.bcc, ...mail });
        messageId = cleanMessageId(receipt?.messageId);
      } catch (err) {
        await store.log(id, "send_batch", actor, { batch: i + 1, of: batches.length, size: (batch.bcc ?? batch.to).length, ok: false, error: message(err).slice(0, 300) });
        throw err;
      }
      sentBatches++;
      if (messageId) messageIds.push(messageId);
      // The provider's id for the message, so a send can be found in the mail logs (no addresses are logged).
      await store.log(id, "send_batch", actor, { batch: i + 1, of: batches.length, size: (batch.bcc ?? batch.to).length, ok: true, ...(messageId ? { message_id: messageId } : {}) });
    }
  } catch (err) {
    const partial = sentBatches > 0 ? ` ${sentBatches} of ${batches.length} batches had already been sent; check before sending again.` : "";
    const error = `${message(err).slice(0, 300)}${partial}`;
    await store.update(id, { status: "failed", error }, ["sending"]);
    await store.log(id, "send_failed", actor, { error, batches_sent: sentBatches, of: batches.length });
    return { ok: false, error, status: "failed" };
  }

  await store.update(id, { status: "sent", sent_at: deps.now().toISOString(), recipient_count: total, error: null }, ["sending"]);
  await store.log(id, "sent", actor, { recipients: total, batches: batches.length, ...(messageIds.length ? { message_ids: messageIds } : {}) });
  return { ok: true, batches: batches.length, recipients: total, status: "sent" };
}

/** "Send now": admin only. */
export async function sendDigestNow(deps: SendDeps, id: string): Promise<SendResult> {
  const admin = await asAdmin(deps);
  if (!admin) return { ok: false, error: NOT_ADMIN };
  return sendClaimed(deps, id, admin);
}

// ---------------------------------------------------------------------------
// Stuck in "sending", and retrying a failed digest (BE-03)
// ---------------------------------------------------------------------------

export const STUCK_AFTER_MS = DIGEST_STUCK_MINUTES * 60_000;

/** Whole minutes a digest has been in "sending" when that is longer than the limit, otherwise null. */
export function stuckMinutes(row: Pick<DigestRow, "status" | "updated_at">, now: Date): number | null {
  if (row.status !== "sending") return null;
  const since = now.getTime() - new Date(row.updated_at).getTime();
  return Number.isFinite(since) && since > STUCK_AFTER_MS ? Math.floor(since / 60_000) : null;
}

/**
 * "Mark as failed": admin only. A digest stays in "sending" forever when the function that was sending it stopped
 * (the final update never happened). After 15 minutes the admin can end that state, which allows editing or a retry.
 * It is not offered earlier, so a send that is really still running is not flipped under its own feet. Logged.
 */
export async function markDigestFailed(deps: DigestDeps, id: string): Promise<Result<{ minutes: number }>> {
  const admin = await asAdmin(deps);
  if (!admin) return { ok: false, error: NOT_ADMIN };

  const row = await deps.store.getById(id);
  if (!row) return { ok: false, error: "Digest not found." };
  if (row.status !== "sending") return { ok: false, error: `Only a digest that is stuck in sending can be marked as failed (this one is ${row.status}).` };
  const minutes = stuckMinutes(row, deps.now());
  if (minutes === null) return { ok: false, error: `This digest has been sending for less than ${DIGEST_STUCK_MINUTES} minutes, so it is not stuck yet. Wait, then try again.` };

  const error = `Marked as failed by ${admin} after being stuck in sending for ${minutes} minutes. Some messages may already have gone out: check before retrying.`;
  const saved = await deps.store.update(id, { status: "failed", error }, ["sending"]);
  if (!saved) return { ok: false, error: "This digest is no longer sending." };
  await deps.store.log(id, "marked_failed", admin, { minutes, previous_status: "sending" });
  return { ok: true, minutes };
}

/**
 * "Retry" for a failed digest: admin only. It goes back to approved (the retrying admin is the approver) and is sent
 * at once, by the same atomic claim as any send, so a double click sends once. Nothing changes when mail is off
 * or there is nobody to send to. A failure that had already sent some batches is shown on the digest: the
 * admin decides, and those recipients can get a second copy.
 */
export async function retryDigest(deps: SendDeps, id: string): Promise<SendResult> {
  const admin = await asAdmin(deps);
  if (!admin) return { ok: false, error: NOT_ADMIN };

  if (deps.provider.name === "none") return { ok: false, error: MAIL_DISABLED_MESSAGE };
  const row = await deps.store.getById(id);
  if (!row) return { ok: false, error: "Digest not found." };
  if (row.status !== "failed") return { ok: false, error: `Only a failed digest can be retried (this one is ${row.status}).`, status: row.status };
  if ((await recipientCount(deps)) === 0) return { ok: false, error: "There are no recipients." };

  const moved = await deps.store.update(id, { status: "approved", approved_by: admin, approved_at: deps.now().toISOString(), error: null }, ["failed"]);
  if (!moved) return { ok: false, error: "This digest is no longer failed: reload and check it." };
  await deps.store.log(id, "retry", admin, { previous_error: (row.error ?? "").slice(0, 300) });
  return sendClaimed(deps, id, admin);
}

/** "Send test to me": only ever to the signed-in admin's own address; the digest's status is untouched. */
export async function sendTestToAdmin(deps: SendDeps, id: string): Promise<Result> {
  const admin = await asAdmin(deps);
  if (!admin) return { ok: false, error: NOT_ADMIN };

  const row = await deps.store.getById(id);
  if (!row) return { ok: false, error: "Digest not found." };
  if (row.article_ids.length === 0) return { ok: false, error: "The digest has no stories." };
  const articles = await deps.store.articles(row.article_ids);
  if (articles.length === 0) return { ok: false, error: "None of the digest's stories is published any more." };

  try {
    const mail = await deps.buildMail(row, articles, { inlineImages: deps.provider.supportsInlineImages });
    await deps.provider.send({ from: deps.from, to: [admin], ...mail, subject: `[TEST] ${mail.subject}` });
  } catch (err) {
    return { ok: false, error: message(err).slice(0, 300) };
  }
  await deps.store.log(id, "test_sent", admin);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The scheduled send (cron)
// ---------------------------------------------------------------------------

export type ScheduledResult =
  | { action: "none" }
  | { action: "sent"; batches: number; recipients: number }
  | { action: "send_failed"; error: string }
  | { action: "not_sent"; status: DigestStatus }
  | { action: "reminded" }
  | { action: "reminder_failed"; error: string }
  | { action: "already_reminded" };

export type ReminderDeps = SendDeps & { adminEmails: string[]; siteUrl: string | null };

/**
 * Monday's scheduled send. Approved: send it. Still a draft: send NOTHING and email the admins a
 * reminder (once). Anything else (sent, sending, failed, skipped): do nothing.
 */
export async function runScheduledSend(deps: ReminderDeps): Promise<ScheduledResult> {
  const row = await deps.store.getByWeek(weekStart(deps.now()));
  if (!row) return { action: "none" };

  if (row.status === "approved") {
    const sent = await sendClaimed(deps, row.id, "cron");
    return sent.ok ? { action: "sent", batches: sent.batches, recipients: sent.recipients } : { action: "send_failed", error: sent.error };
  }
  if (row.status !== "draft") return { action: "not_sent", status: row.status };

  // Reminder: claim it first so a repeated run does not send a second one.
  const claimed = await deps.store.update(row.id, { reminder_sent_at: deps.now().toISOString() }, ["draft"], { reminderUnsent: true });
  if (!claimed) return { action: "already_reminded" };
  const link = deps.siteUrl ? `${deps.siteUrl.replace(/\/+$/, "")}/admin/digest` : "/admin/digest";
  try {
    if (deps.adminEmails.length === 0) throw new Error("ADMIN_EMAILS is empty.");
    await deps.provider.send({
      from: deps.from,
      to: [deps.from],
      bcc: deps.adminEmails,
      subject: "Digest waiting for your approval",
      text: `This week's Company Newsroom digest is still a draft, so it was not sent.\nReview and approve it here: ${link}\n`,
      html: `<p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;">This week's Company Newsroom digest is still a draft, so it was not sent.</p><p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;"><a href="${link}">Review and approve it</a></p>`,
    });
  } catch (err) {
    // Let the next run try again, and say why.
    await deps.store.update(row.id, { reminder_sent_at: null }, ["draft"]);
    const error = err instanceof MailError ? err.message : message(err).slice(0, 300);
    await deps.store.log(row.id, "reminder_failed", "cron", { error });
    return { action: "reminder_failed", error };
  }
  await deps.store.log(row.id, "reminder_sent", "cron", { admins: deps.adminEmails.length });
  return { action: "reminded" };
}
