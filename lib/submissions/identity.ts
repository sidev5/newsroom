import { createHmac } from "node:crypto";
import { isIP } from "node:net";

// Who is submitting: the email's domain and a one-way hash of the network address. Pure, apart from the clock-free HMAC.

/** Lower-cased, trimmed. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The part after the last "@", lower-cased. Empty when there is none. */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).trim().toLowerCase();
}

/**
 * True when the address is on one of the allowed domains. The comparison is on the whole domain
 * ("@adorpower.com"), so "x@evil-adorpower.com" and "x@adorpower.com.evil.io" do not match.
 * An empty list allows everything (the caller flags those submissions as unverified).
 */
export function emailAllowed(email: string, allowedDomains: readonly string[]): boolean {
  if (allowedDomains.length === 0) return true;
  const domain = emailDomain(email);
  return allowedDomains.some((d) => d.toLowerCase() === domain);
}

/** "@a.com", or "@a.com or @b.org", for the error message. */
export function describeDomains(domains: readonly string[]): string {
  return domains.map((d) => `@${d}`).join(" or ");
}

/**
 * The visitor's address from the proxy headers, or null when there is none or it is not an IP.
 * The first x-forwarded-for entry is the client as seen by the platform's edge.
 */
export function clientIp(headers: { get(name: string): string | null }): string | null {
  const candidates = [headers.get("x-forwarded-for")?.split(",")[0], headers.get("x-real-ip")];
  for (const raw of candidates) {
    const ip = raw?.trim();
    if (ip && isIP(ip)) return ip.toLowerCase();
  }
  return null;
}

/**
 * Keyed hash of the address, so the raw IP is never stored and the hash cannot be reversed by trying
 * every IPv4 address without the secret. IPv6 addresses are reduced to their /64, because one home
 * connection controls a whole /64.
 */
export function hashIp(ip: string, secret: string): string {
  return createHmac("sha256", secret).update(ipBucket(ip)).digest("hex");
}

function ipBucket(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const full = expandIpv6(ip);
  return full ? `${full.slice(0, 4).join(":")}::/64` : ip;
}

/** The eight 16-bit groups of an IPv6 address, or null if it does not parse. */
function expandIpv6(ip: string): string[] | null {
  let addr = ip.split("%")[0].toLowerCase();
  // An embedded IPv4 tail ("::ffff:1.2.3.4") counts as two groups.
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(addr);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    addr = addr.replace(v4[0], `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`);
  }
  const [head, tail, ...rest] = addr.split("::");
  if (rest.length > 0) return null;
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  if (tail === undefined) return left.length === 8 ? left.map((g) => g.padStart(4, "0")) : null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return [...left, ...Array<string>(missing).fill("0"), ...right].map((g) => g.padStart(4, "0"));
}
