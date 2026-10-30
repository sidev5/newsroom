"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { bannerParams, errorCodeFor, isNotAuthorised, LOGIN_EXPIRED_PATH, type Banner } from "@/lib/admin/messages";
import { addRecipients, removeRecipient, setRecipientActive } from "@/lib/digest/recipients";
import { digestDeps, recipientDeps, sendDeps } from "@/lib/digest/runtime";
import { adminCreateDraft, approveDigest, markDigestFailed, retryDigest, sendDigestNow, sendTestToAdmin, unapproveDigest, updateDigest } from "@/lib/digest/service";
import { DigestSchemaError } from "@/lib/digest/store";

// Every action re-checks the admin inside lib/digest/*; hiding a button is not the protection.
// The banner after an action is a code in the URL, mapped to fixed wording in lib/admin/messages.ts.

const field = (form: FormData, name: string) => String(form.get(name) ?? "");

function back(banner: Banner): never {
  revalidatePath("/admin/digest");
  redirect(`/admin/digest?${new URLSearchParams(bannerParams(banner))}`);
}

/** A failed action: an expired session goes to the login page, anything else becomes a coded banner. */
function fail(error: string | undefined): never {
  if (isNotAuthorised(error)) redirect(LOGIN_EXPIRED_PATH);
  back({ error: errorCodeFor(error) });
}

/** Runs an action and turns a missing table or a configuration problem into an error result instead of a 500. */
async function guarded<T>(fn: () => Promise<T>): Promise<T | { ok: false; error: string }> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DigestSchemaError) return { ok: false, error: err.message };
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : "Something went wrong." };
  }
}

export async function createDraftAction() {
  const r = await guarded(() => adminCreateDraft(digestDeps()));
  if (!r.ok) fail(r.error);
  const d = r.draft;
  if (d.kind === "skipped") back({ error: "digest_no_candidates" });
  if (d.kind === "exists") back({ notice: "digest_exists" });
  back({ notice: "digest_created", n: d.digest.article_ids.length });
}

export async function saveDigestAction(form: FormData) {
  const r = await guarded(() =>
    updateDigest(digestDeps(), field(form, "id"), {
      subject: field(form, "subject"),
      intro: field(form, "intro"),
      articleIds: form.getAll("ids").map(String),
    }),
  );
  if (!r.ok) fail(r.error);
  if (!r.changed) back({ notice: "digest_unchanged" });
  back({ notice: r.approvalReset ? "digest_saved_reset" : "digest_saved" });
}

export async function approveAction(form: FormData) {
  const r = await guarded(() => approveDigest(digestDeps(), field(form, "id")));
  if (!r.ok) fail(r.error);
  back({ notice: "digest_approved" });
}

export async function unapproveAction(form: FormData) {
  const r = await guarded(() => unapproveDigest(digestDeps(), field(form, "id")));
  if (!r.ok) fail(r.error);
  back({ notice: "digest_unapproved" });
}

export async function sendTestAction(form: FormData) {
  const r = await guarded(() => sendTestToAdmin(sendDeps(), field(form, "id")));
  if (!r.ok) fail(r.error);
  back({ notice: "digest_test_sent" });
}

export async function sendNowAction(form: FormData) {
  // The modal posts confirm=yes; a stray submit without it does nothing.
  if (field(form, "confirm") !== "yes") back({ error: "digest_sending_needs_confirmation" });
  const r = await guarded(() => sendDigestNow(sendDeps(), field(form, "id")));
  if (!r.ok) fail(r.error);
  back({ notice: "digest_sent", n: r.recipients, k: r.batches });
}

/** "Mark as failed" for a digest stuck in sending for over 15 minutes. Admin only (checked in the service); logged. */
export async function markFailedAction(form: FormData) {
  if (field(form, "confirm") !== "yes") back({ error: "needs_confirmation" });
  const r = await guarded(() => markDigestFailed(digestDeps(), field(form, "id")));
  if (!r.ok) fail(r.error);
  back({ notice: "digest_marked_failed", n: r.minutes });
}

/** "Retry" for a failed digest: back to approved and sent at once. Admin only; logged. */
export async function retryAction(form: FormData) {
  if (field(form, "confirm") !== "yes") back({ error: "digest_sending_needs_confirmation" });
  const r = await guarded(() => retryDigest(sendDeps(), field(form, "id")));
  if (!r.ok) fail(r.error);
  back({ notice: "digest_sent", n: r.recipients, k: r.batches });
}

export async function addRecipientsAction(form: FormData) {
  const r = await guarded(() => addRecipients(recipientDeps(), field(form, "emails")));
  if (!r.ok) fail(r.error);
  back({ notice: "recipients_added", n: r.added, k: r.duplicates, m: r.invalid });
}

export async function removeRecipientAction(form: FormData) {
  // The dialog posts confirm=yes; the admin check inside removeRecipient comes first, then this confirmation.
  const r = await guarded(() => removeRecipient(recipientDeps(), field(form, "id"), field(form, "confirm") === "yes"));
  if (!r.ok) fail(r.error);
  back({ notice: "recipient_removed" });
}

export async function setRecipientActiveAction(form: FormData) {
  const r = await guarded(() => setRecipientActive(recipientDeps(), field(form, "id"), field(form, "active") === "true"));
  if (!r.ok) fail(r.error);
  back({ notice: "recipient_updated" });
}
