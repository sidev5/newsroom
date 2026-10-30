// Admin pages show a banner after an action. The text is never taken from the URL: the URL carries a short
// code (and a few small numbers), and the page looks the wording up here. A crafted link can therefore only
// show one of these fixed messages (SEC-09). Details of a failure go to the server log, not into the URL.

/** The exact text every admin function returns when the caller is not (or no longer) an admin. */
export const NOT_AUTHORISED = "Not authorised.";

/** Where an expired or missing admin session is sent. */
export const LOGIN_EXPIRED_PATH = "/admin/login?reason=expired";

/** Shown on the login page for ?reason=expired (the only reason the proxy and the actions send people there with). */
export const EXPIRED_MESSAGE = "You were signed out after a period of inactivity. Please sign in again.";

export function isNotAuthorised(error: string | null | undefined): boolean {
  return error === NOT_AUTHORISED;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const ERROR_TEXT = {
  not_pending: "This article is no longer pending review.",
  not_published: "This article is no longer published.",
  not_rejected: "This article is no longer rejected.",
  not_skipped: "This item is no longer skipped or failed.",
  employee_reason: "Give a reason when rejecting an employee's story, so the decision can be explained to the author.",
  photo_move: "The story was not published because its photo could not be moved to the public bucket. Try again, or check the storage settings.",
  invalid_edit: "The headline or the text is empty or too long (headline up to 200 characters, text up to 20,000).",
  nothing_selected: "Nothing selected.",
  too_many: "Too many selected: choose at most 50 at a time.",
  unknown_department: "Unknown department.",
  pick_department: "Pick a department: this item has none.",
  update_failed: "The change could not be saved. Please try again; the reason is in the server log.",
  load_failed: "Loading failed. Please try again; the reason is in the server log.",
  missing_id: "That item could not be found.",
  needs_confirmation: "This bulk action needs confirmation.",
  digest_not_found: "Digest not found.",
  digest_not_editable: "This digest can no longer be edited.",
  digest_story_unpublished: "One of the digest's stories is not published (any more).",
  digest_not_draft: "Only a draft can be approved.",
  digest_no_stories: "The digest has no stories.",
  digest_no_recipients: "Add at least one recipient (or set DIGEST_TO) before approving or sending.",
  digest_changed: "The digest changed while you were working on it. Reload and check it.",
  digest_cannot_unapprove: "Only an approved digest that has not started sending can be unapproved.",
  digest_already_sent: "This digest has already been sent.",
  digest_not_approved: "Only an approved digest is sent.",
  digest_already_sending: "This digest is already being sent, or is no longer approved.",
  digest_tables_missing: "The digest tables are missing. Run supabase/migrations/2026-10-16_weekly_digest.sql in the Supabase SQL editor, then reload.",
  digest_no_candidates: "No new published stories in the last 7 days, so there is no digest this week.",
  digest_sending_needs_confirmation: "Sending needs confirmation.",
  digest_remove_needs_confirmation: "Removing a recipient needs confirmation.",
  mail_disabled: "Email sending is switched off (EMAIL_PROVIDER=none). Use Download .eml, or set EMAIL_PROVIDER to smtp or graph.",
  smtp_auth: "SMTP AUTH is disabled for this mailbox; ask IT to enable it, or use Download .eml",
  digest_not_stuck: "This digest has been sending for less than 15 minutes, so it is not stuck yet. Wait, then try again.",
  digest_not_sending: "Only a digest that is stuck in sending can be marked as failed.",
  digest_not_failed: "Only a failed digest can be retried.",
  budget_invalid: "Enter an amount in dollars, for example 5.",
  budget_not_higher: "The new limit must be higher than today's limit.",
  budget_too_high: "That is more than the highest limit that can be set.",
  send_failed:
    "Sending did not work. The reason is shown on the digest and in the digest log. Some messages may already have gone out: check before sending again.",
  recipients_none_valid: "None of those look like email addresses.",
  recipients_paste_empty: "Paste at least one email address.",
  recipients_too_many: "Add at most 500 addresses at a time.",
  recipient_gone: "That recipient no longer exists.",
  comment_gone: "That comment no longer exists.",
  generic: "That did not work. Please try again; the reason is in the server log.",
} as const;

export type ErrorCode = keyof typeof ERROR_TEXT;

/** Known function messages, most specific first. Anything else is "generic" (the original goes to the log). */
const RULES: [RegExp, ErrorCode][] = [
  [/^This article is no longer pending review\.$/, "not_pending"],
  [/^This article is no longer published\.$/, "not_published"],
  [/^This article is no longer rejected\.$/, "not_rejected"],
  [/^This item is no longer skipped or failed\.$/, "not_skipped"],
  [/^Give a reason when rejecting an employee/, "employee_reason"],
  [/^The story was not published because its photo/, "photo_move"],
  [/^(Headline|Body) (is required|is too long)/, "invalid_edit"],
  [/^Nothing selected\.$/, "nothing_selected"],
  [/^Select at most \d+ /, "too_many"],
  [/^Unknown department\.$/, "unknown_department"],
  [/^Pick a department/, "pick_department"],
  [/^Update failed:/, "update_failed"],
  [/^(Loading failed|Saving the digest|Loading the digest)/, "load_failed"],
  [/^Missing (article )?id\.$/, "missing_id"],
  [/^Bulk .* needs confirmation\.$/, "needs_confirmation"],
  [/^Digest not found\.$/, "digest_not_found"],
  [/cannot be edited\.$|can no longer be edited/, "digest_not_editable"],
  [/is not published \(any more\)|stories is published any more|None of the digest/, "digest_story_unpublished"],
  [/^Only a draft can be approved/, "digest_not_draft"],
  [/^The digest has no stories\.$/, "digest_no_stories"],
  [/Add at least one recipient|^There are no recipients\.$/, "digest_no_recipients"],
  [/^The digest changed while you were approving it/, "digest_changed"],
  [/^Only an approved digest that has not started sending/, "digest_cannot_unapprove"],
  [/^This digest has already been sent\.$/, "digest_already_sent"],
  [/^Only an approved digest is sent/, "digest_not_approved"],
  [/^This digest is already being sent/, "digest_already_sending"],
  [/^This digest has been sending for less than/, "digest_not_stuck"],
  [/^Only a digest that is stuck in sending/, "digest_not_sending"],
  [/^Only a failed digest can be retried/, "digest_not_failed"],
  [/^This digest is no longer (sending|failed)/, "digest_changed"],
  [/^Enter an amount in dollars/, "budget_invalid"],
  [/^The new limit must be higher than/, "budget_not_higher"],
  [/^That is more than the highest limit/, "budget_too_high"],
  [/^The digest tables are missing/, "digest_tables_missing"],
  [/^No new published stories in the last 7 days/, "digest_no_candidates"],
  [/^Sending needs confirmation\.$/, "digest_sending_needs_confirmation"],
  [/^Removing a recipient needs confirmation\.$/, "digest_remove_needs_confirmation"],
  [/^Email sending is switched off/, "mail_disabled"],
  [/^SMTP AUTH is disabled/, "smtp_auth"],
  [/batches had already been sent|^Invalid (SMTP|Microsoft Graph) settings|^Could not send|failed \(/i, "send_failed"],
  [/^None of those look like email addresses\.$/, "recipients_none_valid"],
  [/^Paste at least one email address\.$/, "recipients_paste_empty"],
  [/^Add at most \d+ addresses/, "recipients_too_many"],
  [/^That recipient no longer exists\.$/, "recipient_gone"],
  [/^That comment no longer exists\.$/, "comment_gone"],
];

/** The code for an error message returned by an admin function. The original text is logged, never shown from the URL. */
export function errorCodeFor(message: string | null | undefined, log: (m: string) => void = console.error): ErrorCode {
  const text = (message ?? "").trim();
  for (const [re, code] of RULES) if (re.test(text)) return code;
  if (text) log(`admin action failed: ${text.slice(0, 300)}`);
  return "generic";
}

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

type Counts = { n: number; k: number; m: number };
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const NOTICE_TEXT = {
  published: () => "Published.",
  rejected: () => "Rejected.",
  saved: () => "Edits saved.",
  unpublished: () => "Unpublished. The article is back in Pending.",
  restored: () => "Restored. It is back in Pending, with the fact-check report.",
  marked_relevant: () => "Marked relevant. The next write run will pick it up.",
  bulk_published: (c: Counts) => `Published ${plural(c.n, "article", "articles")}.`,
  bulk_rejected: (c: Counts) => `Rejected ${plural(c.n, "article", "articles")}.`,
  bulk_restored: (c: Counts) => `Restored ${plural(c.n, "article", "articles")}.`,
  bulk_marked: (c: Counts) => `Marked relevant ${plural(c.n, "article", "articles")}.`,
  digest_created: (c: Counts) => `Draft created with ${plural(c.n, "story", "stories")}.`,
  digest_exists: () => "This week's digest already exists. It was left as it is.",
  digest_saved: () => "Saved.",
  digest_saved_reset: () => "Saved. The digest was approved before, so it is a draft again: approve it again to send it.",
  digest_unchanged: () => "No changes to save.",
  digest_approved: () => "Approved. It goes out at the next scheduled send, or use Send now.",
  digest_unapproved: () => "Approval withdrawn. The digest is a draft again.",
  digest_test_sent: () => "Test sent to your own address.",
  digest_marked_failed: (c: Counts) => `Marked as failed after ${plural(c.n, "minute", "minutes")} in sending. Check the mailbox for messages that already went out, then retry or edit the digest.`,
  budget_raised: () => "Today's AI spend limit was raised. Paused stages can run again.",
  digest_sent: (c: Counts) => `Sent to ${plural(c.n, "recipient", "recipients")} in ${plural(c.k, "message", "messages")}.`,
  recipients_added: (c: Counts) =>
    [`Added ${c.n}.`, c.k ? `${c.k} already on the list.` : "", c.m ? `${c.m} did not look like an address and ${c.m === 1 ? "was" : "were"} skipped.` : ""].filter(Boolean).join(" "),
  recipient_removed: () => "Removed.",
  recipient_updated: () => "Updated.",
  comment_hidden: () => "Comment hidden. It is no longer shown to readers.",
  comment_shown: () => "Comment shown again.",
} satisfies Record<string, (c: Counts) => string>;

export type NoticeCode = keyof typeof NOTICE_TEXT;

export const AUDIT_WARNING = "The change was saved but the audit log entry could not be written.";

export type Banner = {
  notice?: NoticeCode;
  error?: ErrorCode;
  /** Counts for the wording: items done, items skipped or already there, items invalid. */
  n?: number;
  k?: number;
  m?: number;
  /** Why the skipped ones were skipped (an error code). */
  why?: ErrorCode;
  /** The audit log write failed. */
  warn?: boolean;
};

/** The query parameters for a redirect: codes and small numbers only. */
export function bannerParams(b: Banner): Record<string, string> {
  const out: Record<string, string> = {};
  if (b.notice) out.notice = b.notice;
  if (b.error) out.error = b.error;
  for (const key of ["n", "k", "m"] as const) {
    const v = b[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[key] = String(Math.min(9999, Math.floor(v)));
  }
  if (b.why) out.why = b.why;
  if (b.warn) out.warn = "1";
  return out;
}

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
const int = (v: string | string[] | undefined) => {
  const s = one(v);
  return s && /^\d{1,4}$/.test(s) ? Number(s) : 0;
};
const isNotice = (v: string | undefined): v is NoticeCode => v !== undefined && Object.hasOwn(NOTICE_TEXT, v);
const isError = (v: string | undefined): v is ErrorCode => v !== undefined && Object.hasOwn(ERROR_TEXT, v);

export type BannerView = { kind: "ok" | "problem"; text: string };

/** What to show for the page's search parameters: only known codes are looked up; any other value shows nothing. */
export function bannerFromSearch(sp: Search): BannerView | null {
  const c: Counts = { n: int(sp.n), k: int(sp.k), m: int(sp.m) };
  const notice = one(sp.notice);
  const error = one(sp.error);
  const why = one(sp.why);
  const warn = one(sp.warn) === "1";

  if (isNotice(notice)) {
    const parts = [NOTICE_TEXT[notice](c)];
    // A bulk action that skipped some items, or could not write its log, is shown as a problem.
    const skipped = notice.startsWith("bulk_") ? c.k : 0;
    if (skipped > 0) parts.push(`${skipped} skipped${isError(why) ? `: ${ERROR_TEXT[why]}` : "."}`);
    if (warn) parts.push(AUDIT_WARNING);
    return { kind: skipped > 0 || warn ? "problem" : "ok", text: parts.join(" ") };
  }
  if (isError(error)) {
    return { kind: "problem", text: ERROR_TEXT[error] };
  }
  return null;
}

/** An article id from the URL (used only to highlight a card), or null. */
export function articleParam(v: string | string[] | undefined): string | null {
  const s = one(v);
  return s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ? s : null;
}
