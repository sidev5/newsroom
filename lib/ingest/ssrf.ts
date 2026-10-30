import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// SEC-07: the feed and article URLs come from RSS data, so they are untrusted. Before a request goes out, and
// after every redirect, the URL must be plain http(s) on port 80 or 443, with a host that is not (and does not
// resolve to) a private, loopback, link-local, multicast or cloud-metadata address.
//
// Known limit: the address is resolved here and then fetch() resolves it again, so a DNS server that answers
// differently the second time (rebinding) is not stopped. Pinning the connection to the checked address needs a
// custom dispatcher; the check below covers the realistic cases (an item that points at an internal host, a redirect
// to one, a public name that resolves to a private address).

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

/** Resolves a host name to all its addresses. Injected in tests. */
export type Resolver = (host: string) => Promise<string[]>;

export const resolveHost: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

function ipv4Parts(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return nums.every((n) => n >= 0 && n <= 255) ? nums : null;
}

/** [network, prefix length] pairs that are never reachable on the public internet or must not be fetched. */
const BLOCKED_V4: [string, number][] = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, including the cloud metadata address 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and the broadcast address
];

const toInt = (p: number[]) => ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;

function isBlockedV4(parts: number[]): boolean {
  const n = toInt(parts);
  return BLOCKED_V4.some(([net, bits]) => {
    const base = toInt(ipv4Parts(net)!);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) >>> 0 === (base & mask) >>> 0;
  });
}

/** 8 groups of 16 bits, or null when it is not an IPv6 address. Handles "::" and an embedded dotted IPv4 tail. */
function ipv6Groups(input: string): number[] | null {
  let ip = input.split("%")[0].toLowerCase();
  const tail = ip.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const v4 = ipv4Parts(tail[1]);
    if (!v4) return null;
    ip = ip.slice(0, -tail[1].length) + ((v4[0] << 8) | v4[1]).toString(16) + ":" + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...rest].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : null;
}

const v4FromGroups = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];

/** True for every address a feed or page fetch must never connect to. Unparseable input is blocked. */
export function isBlockedAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const parts = ipv4Parts(address);
    return !parts || isBlockedV4(parts);
  }
  if (kind === 6) {
    const g = ipv6Groups(address);
    if (!g) return true;
    // ::, ::1 and the deprecated IPv4-compatible ::a.b.c.d
    if (g.slice(0, 6).every((x) => x === 0)) return true;
    // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) carry an IPv4 address: judge that one.
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isBlockedV4(v4FromGroups(g[6], g[7]));
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isBlockedV4(v4FromGroups(g[6], g[7]));
    // Only global unicast (2000::/3) is allowed, minus the ranges that are documentation, protocol or 6to4.
    if ((g[0] & 0xe000) !== 0x2000) return true; // unique-local fc00::/7, link-local fe80::/10, multicast ff00::/8, ...
    if (g[0] === 0x2001 && (g[1] === 0x0db8 || g[1] < 0x0200)) return true; // 2001:db8::/32 and 2001::/23 (Teredo, ORCHID, ...)
    if (g[0] === 0x2002) return true; // 6to4
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

const ALLOWED_PORTS = new Set(["", "80", "443"]); // URL drops a scheme's own default port, so "" is 80 or 443

function blockedName(host: string): boolean {
  return host === "localhost" || !host.includes(".") || /\.(localhost|local|internal|localdomain|lan|home)$/.test(host);
}

/**
 * Throws BlockedUrlError unless `rawUrl` may be fetched: http or https, port 80 or 443, no credentials, and a
 * host that is a public address (or resolves only to public addresses). Returns the parsed URL.
 */
export async function assertSafeUrl(rawUrl: string, resolve: Resolver = resolveHost): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError(`Not a valid URL: ${rawUrl.slice(0, 100)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedUrlError(`Only http and https URLs are fetched (got ${url.protocol})`);
  if (url.username || url.password) throw new BlockedUrlError("URLs with a user name or password are not fetched");
  if (!ALLOWED_PORTS.has(url.port)) throw new BlockedUrlError(`Only ports 80 and 443 are fetched (got ${url.port})`);

  // new URL() turns 2130706433, 0x7f.1 and similar into dotted form, so an IP literal is judged as an IP.
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new BlockedUrlError(`Refusing to fetch a private or reserved address (${host})`);
    return url;
  }
  if (blockedName(host)) throw new BlockedUrlError(`Refusing to fetch an internal host name (${host})`);

  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new BlockedUrlError(`Could not resolve ${host}`);
  }
  if (addresses.length === 0) throw new BlockedUrlError(`Could not resolve ${host}`);
  const bad = addresses.find(isBlockedAddress);
  if (bad) throw new BlockedUrlError(`${host} resolves to a private or reserved address (${bad})`);
  return url;
}
