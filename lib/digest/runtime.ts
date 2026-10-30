import "server-only";
import { currentAdminEmail } from "@/lib/admin/session";
import { env } from "@/lib/env";
import { getMailProvider, MailError, senderAddress } from "@/lib/mail";
import { makeMailBuilder } from "./prepare";
import type { RecipientDeps } from "./recipients";
import type { DigestDeps, ReminderDeps, SendDeps } from "./service";
import { supabaseDigestStore, supabaseRecipientStore } from "./store";

// Wires the digest logic to the real database, session and mail provider.

export function digestDeps(): DigestDeps {
  const e = env();
  return {
    store: supabaseDigestStore(),
    adminEmail: currentAdminEmail,
    now: () => new Date(),
    maxStories: e.DIGEST_MAX_STORIES,
    distributionList: e.DIGEST_TO ?? null,
  };
}

export function recipientDeps(): RecipientDeps {
  const store = supabaseDigestStore();
  return { recipients: supabaseRecipientStore(), adminEmail: currentAdminEmail, log: store.log };
}

/** The sender shown on digest mail. MAIL_FROM is required when a provider that sends is selected. */
const PLACEHOLDER_FROM = "Company Newsroom <newsroom@localhost.invalid>";

export function siteUrl(): string {
  const url = env().SITE_URL;
  if (!url) throw new MailError("SITE_URL is not set: the email needs the public address of the dashboard for its links.", "config");
  return url.replace(/\/+$/, "");
}

/** Dependencies for building and sending mail. Mail settings are validated here, only when this is used. */
export function sendDeps(): SendDeps {
  const e = env();
  return {
    ...digestDeps(),
    provider: getMailProvider(),
    buildMail: makeMailBuilder({ siteUrl: siteUrl(), contact: e.DIGEST_CONTACT ?? null }),
    from: senderAddress() ?? PLACEHOLDER_FROM,
  };
}

export function reminderDeps(): ReminderDeps {
  const e = env();
  return { ...sendDeps(), adminEmails: e.ADMIN_EMAILS, siteUrl: e.SITE_URL ?? null };
}
