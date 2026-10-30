import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { READER_LIMITS } from "@/lib/config";
import { cleanLine } from "@/lib/submissions/text";

// Who is liking and commenting. There is no employee sign-in on this site, so a reader proves a company email with a
// one-time code sent to it (lib/reader/auth.ts), and from then on carries a signed cookie. What is stored is only a keyed
// hash of the address (the "user_key"); the address itself is never written down. Pure apart from node:crypto.

export const READER_COOKIE = "newsroom_reader";

const mac = (secret: string, label: string, value: string) => createHmac("sha256", secret).update(`${label}\n${value}`).digest("hex");

/** The person's stable key: an HMAC of the lower-cased address. The same person gets the same key on every visit and device. */
export function readerKey(email: string, secret: string): string {
  return mac(secret, "reader-key", email.trim().toLowerCase());
}

/** The hash of a one-time code, bound to the address it was sent to, so a code cannot be tried against another person's request. */
export function codeHash(code: string, emailKey: string, secret: string): string {
  return mac(secret, "reader-code", `${emailKey}:${code}`);
}

/** A fresh code of READER_LIMITS.CODE_DIGITS digits from a cryptographic source, with leading zeros kept. */
export function newCode(): string {
  return String(randomInt(0, 10 ** READER_LIMITS.CODE_DIGITS)).padStart(READER_LIMITS.CODE_DIGITS, "0");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The name shown next to a comment: the first name taken from the start of the address ("ada.lovelace@..." is "Ada"). Letters
 * only, capitalised, at most 30 characters; "Colleague" when nothing usable is left. The address itself is never shown.
 */
export function displayName(email: string): string {
  const local = email.split("@")[0] ?? "";
  const first = local.split(/[._\-+0-9]/)[0] ?? "";
  const letters = cleanLine(first).replace(/[^\p{L}]/gu, "").slice(0, 30);
  return letters.length >= 2 ? letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase() : "Colleague";
}

export type ReaderSession = {
  /** The user key. */
  k: string;
  /** The display name. */
  n: string;
  /** Expiry, in seconds since 1970. */
  exp: number;
};

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

/** `<payload>.<signature>`: the payload is readable by the reader, the signature is what makes it unforgeable. */
export function signSession(session: ReaderSession, secret: string): string {
  const payload = b64(JSON.stringify(session));
  return `${payload}.${mac(secret, "reader-session", payload)}`;
}

/** The session in a cookie value, or null when it is missing, altered or expired. */
export function verifySession(value: string | undefined | null, secret: string, nowMs: number): ReaderSession | null {
  if (!value || value.length > 1000) return null;
  const dot = value.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = value.slice(0, dot);
  if (!safeEqual(value.slice(dot + 1), mac(secret, "reader-session", payload))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<ReaderSession>;
    if (typeof s.k !== "string" || !/^[0-9a-f]{64}$/.test(s.k) || typeof s.n !== "string" || typeof s.exp !== "number") return null;
    return s.exp * 1000 > nowMs ? { k: s.k, n: s.n.slice(0, 40), exp: s.exp } : null;
  } catch {
    return null;
  }
}

export function newSession(email: string, secret: string, nowMs: number): ReaderSession {
  return { k: readerKey(email, secret), n: displayName(email), exp: Math.floor(nowMs / 1000) + READER_LIMITS.SESSION_DAYS * 86_400 };
}

/** The value of one cookie in a Cookie header. */
export function cookieValue(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** The session cookie as a Set-Cookie value: HttpOnly, SameSite=Lax, Secure on https, for exactly the session's lifetime. */
export function sessionCookie(value: string, secure: boolean, maxAgeSeconds = READER_LIMITS.SESSION_DAYS * 86_400): string {
  return `${READER_COOKIE}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export const clearedCookie = (secure: boolean) => sessionCookie("", secure, 0);
