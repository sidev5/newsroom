// npm run start:lan: serves the built app on a company LAN over plain http, for a Windows PC run by NSSM (docs/SELF_HOST.md).
// Use it instead of `next start` there. Vercel and every https deployment keep using `next start`; nothing here changes them.
//
// What it adds to `next start`:
//   - Nothing stands in front of this server, so any X-Forwarded-* / X-Real-IP / Forwarded header a client sends is forged.
//     They are replaced with the truth (socket address, http, the Host header), so the per-address limits on /submit and the
//     reader sign-in count real machines and the cookies are never marked Secure on an http page (the browser would drop them).
//   - /admin answers only to this PC unless SELF_HOST_ADMIN=lan-insecure-http (lib/admin/network.ts). The socket address is
//     passed to the app in x-newsroom-client with a token made at start-up, so the app can tell it from a forged header.
//
// Settings (environment or .env.local): HOST (default 0.0.0.0), PORT (default 3000), SELF_HOST_ADMIN (localhost | lan-insecure-http).
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CLIENT_HEADER = "x-newsroom-client";
const FORGEABLE = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "x-real-ip", CLIENT_HEADER];

/** Replaces the client's proxy headers with what this server actually saw. Mutates and returns `headers`. */
export function trustedHeaders(headers, { remoteAddress, port, token }) {
  for (const name of FORGEABLE) delete headers[name];
  // "::ffff:10.0.0.5" (a dual-stack socket) is an IPv4 client: hashed as IPv6, every such client would share one /64 limit.
  const address = (remoteAddress ?? "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
  headers["x-forwarded-for"] = address;
  headers["x-forwarded-proto"] = "http";
  headers["x-forwarded-port"] = String(port);
  if (headers.host) headers["x-forwarded-host"] = headers.host;
  headers[CLIENT_HEADER] = `${token} ${address}`;
  return headers;
}

/** The admin policy from SELF_HOST_ADMIN: only the exact opt-in value opens /admin to the LAN. */
export function adminPolicy(value) {
  const v = (value ?? "").trim();
  if (v === "lan-insecure-http") return "lan-insecure-http";
  if (v !== "" && v !== "localhost") console.warn(`SELF_HOST_ADMIN="${v}" is not a known value; using localhost.`);
  return "localhost";
}

async function main() {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
  process.env.NODE_ENV = "production";
  // .env.local first, so HOST, PORT and SELF_HOST_ADMIN can live there too (Next loads it again later; set values win).
  const { loadEnvConfig } = (await import("@next/env")).default;
  loadEnvConfig(dir, false);

  const hostname = process.env.HOST || "0.0.0.0";
  const port = Number.parseInt(process.env.PORT || "3000", 10);
  const policy = adminPolicy(process.env.SELF_HOST_ADMIN);
  const token = randomBytes(32).toString("hex");
  // Read by lib/admin/network.ts. Set here, never in .env files.
  process.env.NEWSROOM_SELF_HOST_TOKEN = token;
  process.env.NEWSROOM_SELF_HOST_ADMIN = policy;

  const next = (await import("next")).default;
  const app = next({ dev: false, dir, hostname, port });
  const handle = app.getRequestHandler();
  await app.prepare();

  createServer((req, res) => {
    trustedHeaders(req.headers, { remoteAddress: req.socket.remoteAddress, port, token });
    handle(req, res);
  }).listen(port, hostname, () => {
    console.log(`> Newsroom listening on http://${hostname}:${port} (plain http, LAN only)`);
    if (policy === "lan-insecure-http") {
      console.warn(
        "WARNING: SELF_HOST_ADMIN=lan-insecure-http. /admin is open to the whole network over plain http: admin passwords and " +
          "session cookies travel unencrypted and can be captured by anyone on the LAN. Use it only on a trusted, wired network, " +
          "and switch back to localhost (remove SELF_HOST_ADMIN) as soon as you can.",
      );
    } else {
      console.log("> /admin answers only on this PC (http://localhost:" + port + "/admin). Other machines get 404.");
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase()) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
