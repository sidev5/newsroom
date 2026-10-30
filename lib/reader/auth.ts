import { READER_LIMITS } from "@/lib/config";
import { describeDomains, emailAllowed, normalizeEmail } from "@/lib/submissions/identity";
import { cleanLine } from "@/lib/submissions/text";
import { z } from "zod";
import { codeHash, newSession, readerKey, safeEqual, type ReaderSession } from "./identity";

// Signing in to like or comment: a company email, then a one-time code sent to it. With every outside effect injected.
// Nothing here says whether an address "exists": any address on the allowed domains gets a code (limited per address and per
// connection), and a wrong code costs one of five tries.

export type CodeRow = { id: string; code_hash: string; attempts: number; expires_at: string; used_at: string | null };

export interface AuthStore {
  /** Codes asked for since `sinceIso` by this address and by this connection (null when the connection is unknown). */
  countCodes(args: { emailKey: string; ipHash: string | null; sinceIso: string }): Promise<{ email: number; ip: number | null }>;
  insertCode(row: { emailKey: string; codeHash: string; ipHash: string | null; expiresAtIso: string }): Promise<void>;
  /** The newest code asked for by this address. */
  latestCode(emailKey: string): Promise<CodeRow | null>;
  /** Counts one try, atomically, and resolves to the tries used, or null when none are left. Called BEFORE the code is compared. */
  registerAttempt(id: string, max: number): Promise<number | null>;
  /** Marks the code used. Resolves to false when it was already used (two requests at once), so a code works once. */
  markUsed(id: string, nowIso: string): Promise<boolean>;
  /** Forgets codes that expired before `beforeIso`. */
  prune(beforeIso: string): Promise<void>;
}

export type AuthDeps = {
  store: AuthStore;
  allowedDomains: readonly string[];
  secret: string;
  hashIp: (ip: string) => string;
  now: () => Date;
  makeCode: () => string;
  /** Sends the code by email. Throws when it could not be sent. */
  sendCode: (to: string, code: string) => Promise<void>;
};

export const SIGN_IN_UNAVAILABLE = "Likes and comments are not switched on for this site yet.";
export const SEND_FAILED = "The code could not be sent. Please try again in a few minutes.";
export const TOO_MANY_CODES = "Too many codes were asked for. Please wait a while and try again.";
export const WRONG_CODE = "That code is not right.";
export const CODE_EXPIRED = "That code has expired or was already used. Ask for a new one.";
export const TOO_MANY_TRIES = "Too many wrong tries. Ask for a new code.";
export const BAD_EMAIL = "That does not look like an email address.";

const emailSchema = z.email().max(254);

export type CodeResult = { ok: true } | { ok: false; error: string; kind: "invalid" | "limited" | "server" };

const HOUR = 3_600_000;

export async function requestCode(deps: AuthDeps, input: { email: string; ip: string | null }): Promise<CodeResult> {
  const email = normalizeEmail(cleanLine(input.email));
  if (!emailSchema.safeParse(email).success) return { ok: false, kind: "invalid", error: BAD_EMAIL };
  if (!emailAllowed(email, deps.allowedDomains)) return { ok: false, kind: "invalid", error: `Use your company email address (it must end with ${describeDomains(deps.allowedDomains)}).` };

  const now = deps.now();
  const emailKey = readerKey(email, deps.secret);
  const ipHash = input.ip ? deps.hashIp(input.ip) : null;
  try {
    const counts = await deps.store.countCodes({ emailKey, ipHash, sinceIso: new Date(now.getTime() - HOUR).toISOString() });
    if (counts.email >= READER_LIMITS.CODES_PER_EMAIL_PER_HOUR || (counts.ip !== null && counts.ip >= READER_LIMITS.CODES_PER_IP_PER_HOUR)) {
      return { ok: false, kind: "limited", error: TOO_MANY_CODES };
    }
    const code = deps.makeCode();
    await deps.store.insertCode({ emailKey, codeHash: codeHash(code, emailKey, deps.secret), ipHash, expiresAtIso: new Date(now.getTime() + READER_LIMITS.CODE_TTL_MINUTES * 60_000).toISOString() });
    await deps.sendCode(email, code);
    await deps.store.prune(new Date(now.getTime() - 24 * HOUR).toISOString()).catch(() => {});
    return { ok: true };
  } catch {
    // The message to the visitor never names the cause (a mail server, a database): the route logs it without the address.
    return { ok: false, kind: "server", error: SEND_FAILED };
  }
}

export type VerifyResult = { ok: true; session: ReaderSession } | { ok: false; error: string; kind: "invalid" | "limited" | "server" };

export async function verifyCode(deps: AuthDeps, input: { email: string; code: string }): Promise<VerifyResult> {
  const email = normalizeEmail(cleanLine(input.email));
  const code = input.code.replace(/\s+/g, "");
  if (!emailSchema.safeParse(email).success || !emailAllowed(email, deps.allowedDomains)) return { ok: false, kind: "invalid", error: BAD_EMAIL };
  if (!new RegExp(`^\\d{${READER_LIMITS.CODE_DIGITS}}$`).test(code)) return { ok: false, kind: "invalid", error: `The code has ${READER_LIMITS.CODE_DIGITS} digits.` };

  const now = deps.now();
  const emailKey = readerKey(email, deps.secret);
  try {
    const row = await deps.store.latestCode(emailKey);
    if (!row || row.used_at || new Date(row.expires_at).getTime() <= now.getTime()) return { ok: false, kind: "invalid", error: CODE_EXPIRED };
    // The try is counted first and atomically: parallel guesses cannot get more than CODE_MAX_ATTEMPTS comparisons.
    if ((await deps.store.registerAttempt(row.id, READER_LIMITS.CODE_MAX_ATTEMPTS)) === null) return { ok: false, kind: "limited", error: TOO_MANY_TRIES };
    if (!safeEqual(row.code_hash, codeHash(code, emailKey, deps.secret))) return { ok: false, kind: "invalid", error: WRONG_CODE };
    if (!(await deps.store.markUsed(row.id, now.toISOString()))) return { ok: false, kind: "invalid", error: CODE_EXPIRED };
    return { ok: true, session: newSession(email, deps.secret, now.getTime()) };
  } catch {
    return { ok: false, kind: "server", error: SEND_FAILED };
  }
}
