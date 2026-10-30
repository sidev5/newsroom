// Admin session limits that do not depend on a paid Supabase feature (ADM-02).
//
// A small cookie records when the admin signed in (`start`) and when they last used an admin page (`last`).
// It is signed with HMAC-SHA256, so it cannot be forged or extended by the browser. The proxy refreshes `last`
// on every admin request and signs the user out when either limit is passed; currentAdminEmail() checks the
// same marker again, so a page or action that somehow skipped the proxy is still refused.
//
// Uses Web Crypto only, so it runs in the proxy and in server code alike.

export const ADMIN_ACTIVITY_COOKIE = "nr_admin_activity";

export const DEFAULT_IDLE_MINUTES = 30;
export const DEFAULT_SESSION_HOURS = 8;

export type AdminLimits = { idleMs: number; absoluteMs: number };
type Source = Record<string, string | undefined>;

/** A positive number from the environment, or the default (a typo must not switch a limit off). */
function positive(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value.trim() !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** ADMIN_IDLE_MINUTES (default 30) and ADMIN_SESSION_HOURS (default 8). */
export function adminLimits(source: Source = process.env): AdminLimits {
  return {
    idleMs: positive(source.ADMIN_IDLE_MINUTES, DEFAULT_IDLE_MINUTES) * 60_000,
    absoluteMs: positive(source.ADMIN_SESSION_HOURS, DEFAULT_SESSION_HOURS) * 3_600_000,
  };
}

/** The signing secret: ADMIN_SESSION_SECRET if set, else CRON_SECRET. Null (so every session is refused) if neither is long enough. */
export function markerSecret(source: Source = process.env): string | null {
  for (const candidate of [source.ADMIN_SESSION_SECRET, source.CRON_SECRET]) {
    if (candidate && candidate.length >= 16) return candidate;
  }
  return null;
}

export type Marker = { start: number; last: number };

const enc = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array | null {
  try {
    const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function key(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

/** `<start>.<last>.<signature>`, times in epoch milliseconds. */
export async function signMarker(secret: string, marker: Marker): Promise<string> {
  const payload = `${marker.start}.${marker.last}`;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret, "sign"), enc.encode(payload)));
  return `${payload}.${toBase64Url(sig)}`;
}

/** The marker if the signature is valid, else null. The comparison is constant time (crypto.subtle.verify). */
export async function readMarker(secret: string, value: string | undefined | null): Promise<Marker | null> {
  if (!value) return null;
  const m = /^(\d{10,15})\.(\d{10,15})\.([A-Za-z0-9_-]{20,64})$/.exec(value);
  if (!m) return null;
  const sig = fromBase64Url(m[3]);
  if (!sig) return null;
  const ok = await crypto.subtle.verify("HMAC", await key(secret, "verify"), sig as BufferSource, enc.encode(`${m[1]}.${m[2]}`));
  return ok ? { start: Number(m[1]), last: Number(m[2]) } : null;
}

export type Verdict =
  | { ok: true; marker: Marker }
  /** missing: no cookie (never signed in here, or it was cleared); invalid: forged, damaged or unsigned; idle / absolute: a limit passed. */
  | { ok: false; reason: "missing" | "invalid" | "idle" | "absolute" };

const FUTURE_SKEW_MS = 60_000;

/** Is this marker still good at `now`? Pure apart from the signature check. */
export async function checkActivity(secret: string | null, value: string | undefined | null, now: number, limits: AdminLimits): Promise<Verdict> {
  if (!value) return { ok: false, reason: "missing" };
  if (!secret) return { ok: false, reason: "invalid" };
  const marker = await readMarker(secret, value);
  if (!marker) return { ok: false, reason: "invalid" };
  // A time in the future cannot come from our own signing; treat it as damaged rather than let it extend a session.
  if (marker.last > now + FUTURE_SKEW_MS || marker.start > now + FUTURE_SKEW_MS || marker.last < marker.start) return { ok: false, reason: "invalid" };
  if (now - marker.start > limits.absoluteMs) return { ok: false, reason: "absolute" };
  if (now - marker.last > limits.idleMs) return { ok: false, reason: "idle" };
  return { ok: true, marker };
}

/** Cookie attributes for the marker. `secure` should be true whenever the site is served over https. */
export function markerCookieOptions(secure: boolean, limits: AdminLimits = adminLimits()) {
  return {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    // The browser forgets it after the absolute limit even if the cookie were never cleared.
    maxAge: Math.floor(limits.absoluteMs / 1000),
  };
}
