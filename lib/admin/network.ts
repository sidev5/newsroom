// Who may reach /admin when the app is self-hosted on a company LAN over plain http (docs/SELF_HOST.md).
//
// scripts/self-host-server.mjs starts the app with a random token in NEWSROOM_SELF_HOST_TOKEN and puts the real socket address
// of every request in CLIENT_HEADER as "<token> <address>", after deleting whatever the client sent under that name. The address
// is believed only when the token matches, so a forged header (or plain `next start`, where no token exists) proves nothing.
// X-Forwarded-For cannot serve here: Next keeps a client-sent value, and the proxy has no other way to see the socket.
//
// Policies (SELF_HOST_ADMIN, read by the server script):
//   any               - not started by the self-host server (Vercel, `next start`): no network rule, exactly as before.
//   localhost         - the self-host default: /admin, the login and every admin action answer only to this PC.
//   lan-insecure-http - /admin from the whole LAN over plain http. Passwords and session cookies cross the network in clear
//                       text; the login page says so on every visit from another machine.

export const CLIENT_HEADER = "x-newsroom-client";
export const LAN_INSECURE = "lan-insecure-http";

export type AdminNetwork = "any" | "localhost" | typeof LAN_INSECURE;

type HeaderSource = { get(name: string): string | null };
type Env = Record<string, string | undefined>;

export function adminNetwork(env: Env = process.env): AdminNetwork {
  if (!env.NEWSROOM_SELF_HOST_TOKEN) return "any";
  return env.NEWSROOM_SELF_HOST_ADMIN === LAN_INSECURE ? LAN_INSECURE : "localhost";
}

/** Compares without stopping at the first difference. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The socket address the self-host server vouches for, or null (no server, no header, wrong token). */
export function socketAddress(headers: HeaderSource, env: Env = process.env): string | null {
  const token = env.NEWSROOM_SELF_HOST_TOKEN;
  const value = headers.get(CLIENT_HEADER);
  if (!token || !value) return null;
  const space = value.indexOf(" ");
  if (space < 0 || !sameText(value.slice(0, space), token)) return null;
  return value.slice(space + 1).trim() || null;
}

/** 127.0.0.0/8, ::1 and their IPv4-mapped form. */
export function isLoopback(address: string): boolean {
  const a = address.toLowerCase().replace(/^::ffff:/, "");
  return a === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/** Whether this request may see /admin, sign in or run an admin action. Fails closed under the localhost policy. */
export function adminAllowed(headers: HeaderSource, env: Env = process.env): boolean {
  if (adminNetwork(env) !== "localhost") return true;
  const address = socketAddress(headers, env);
  return address !== null && isLoopback(address);
}

/** True for a plain-http request from another machine under the lan-insecure-http policy: the login page warns. */
export function insecureLanRequest(headers: HeaderSource, env: Env = process.env): boolean {
  if (adminNetwork(env) !== LAN_INSECURE) return false;
  const address = socketAddress(headers, env);
  return address !== null && !isLoopback(address);
}

export const INSECURE_LAN_WARNING =
  "This connection is not encrypted. Your password and your admin session can be read by anyone on the network. Sign in from the server PC itself, or ask IT for an https address.";
