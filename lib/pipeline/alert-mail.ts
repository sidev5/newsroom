import "server-only";
import { env } from "@/lib/env";
import { getMailProvider, senderAddress } from "@/lib/mail";
import type { AlertMail } from "./run-log";

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Where the alert points: the Pipeline tab, as a full link when SITE_URL is set. */
export function pipelineLink(siteUrl: string | undefined | null): string {
  return `${(siteUrl ?? "").replace(/\/+$/, "")}/admin/review?tab=pipeline`;
}

/**
 * Sends the alert email to ADMIN_EMAILS (as BCC, so the admins do not see each other), with the digest's mail provider.
 * Null when email is not configured (EMAIL_PROVIDER=none, no admins, no sender): the banner on /admin is then all there is.
 */
export function pipelineAlertMail(): AlertMail | null {
  try {
    const e = env();
    if (e.ADMIN_EMAILS.length === 0) return null;
    const provider = getMailProvider();
    const from = senderAddress();
    if (provider.name === "none" || !from) return null;
    return {
      async send(subject, text) {
        await provider.send({ from, to: [from], bcc: e.ADMIN_EMAILS, subject, text, html: `<pre style="font-family:Arial,Helvetica,sans-serif;font-size:14px;white-space:pre-wrap;">${escapeHtml(text)}</pre>` });
      },
    };
  } catch {
    return null; // a mail setting is invalid: the digest page says so; here it only means "no email"
  }
}
