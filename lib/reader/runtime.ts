import "server-only";
import { env } from "@/lib/env";
import { emailProvider, getMailProvider, MailError, senderAddress } from "@/lib/mail";
import { hashIp } from "@/lib/submissions/identity";
import type { AuthDeps } from "./auth";
import { cookieValue, newCode, READER_COOKIE, verifySession, type ReaderSession } from "./identity";
import type { EngagementDeps } from "./engagement";
import { supabaseAuthStore, supabaseEngagementStore } from "./store";

// Wires the reader sign-in and the likes and comments to the real database, mail provider and settings.

/** The secret behind the keyed hashes and the cookie signature: the same one as the submission hashes, so there is nothing new to set. */
function secret(): string {
  const e = env();
  return e.SUBMISSION_HASH_SALT ?? e.CRON_SECRET;
}

/** Likes and comments need mail that really sends, and a company domain list: otherwise there is no way to prove a company email. */
export function readerSignInAvailable(): boolean {
  try {
    return emailProvider() !== "none" && env().ALLOWED_EMAIL_DOMAINS.length > 0;
  } catch {
    return false;
  }
}

export function engagementDeps(): EngagementDeps {
  return { store: supabaseEngagementStore(), now: () => new Date() };
}

export function authDeps(): AuthDeps {
  const e = env();
  const key = secret();
  return {
    store: supabaseAuthStore(),
    allowedDomains: e.ALLOWED_EMAIL_DOMAINS,
    secret: key,
    hashIp: (ip) => hashIp(ip, key),
    now: () => new Date(),
    makeCode: newCode,
    async sendCode(to, code) {
      const from = senderAddress();
      if (!from) throw new MailError("MAIL_FROM is not set", "config");
      await getMailProvider().send({
        from,
        to: [to],
        subject: "Your Company Newsroom sign-in code",
        text: `Your sign-in code is ${code}.\n\nIt works for 10 minutes. If you did not ask for it, you can ignore this message.`,
        html: `<p>Your sign-in code is <strong style="font-size:20px;letter-spacing:2px">${code}</strong>.</p><p>It works for 10 minutes. If you did not ask for it, you can ignore this message.</p>`,
      });
    },
  };
}

/** The signed-in reader of a request, from its cookie; null when there is none, or it is altered or expired. */
export function sessionOf(headers: { get(name: string): string | null }): ReaderSession | null {
  try {
    return verifySession(cookieValue(headers.get("cookie"), READER_COOKIE), secret(), Date.now());
  } catch {
    return null;
  }
}

export { secret as readerSecret };
