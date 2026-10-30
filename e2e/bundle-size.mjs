// Measures the JavaScript the homepage loads (and everything that exists in the build), raw and gzipped.
// Next 16 no longer prints "First Load JS", so this builds the app against the local mock (no real database is touched),
// starts it, reads the homepage's <script src> list and adds up those files. Run with `npm run bundle-size`; the output is
// one JSON line, so two runs (before and after a change) can be compared.
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { ADMIN, startMock } from "./mock-supabase.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MOCK_PORT = 54398;
const PORT = 3198;
const SITE = `http://127.0.0.1:${PORT}`;
const next = join(root, "node_modules", "next", "dist", "bin", "next");
const env = {
  ...process.env,
  NODE_ENV: "production",
  NEXT_TELEMETRY_DISABLED: "1",
  NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "mock-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "mock-service-key",
  CRON_SECRET: "e2e-secret-0123456789abcdefghijkl",
  ADMIN_EMAILS: ADMIN.email,
  ALLOWED_EMAIL_DOMAINS: "example.com",
  SITE_URL: SITE,
};

const mock = await startMock({ port: MOCK_PORT });
rmSync(join(root, ".next"), { recursive: true, force: true });
const code = await new Promise((resolve) => spawn(process.execPath, [next, "build"], { cwd: root, env, stdio: "ignore" }).on("exit", resolve));
if (code !== 0) {
  await mock.close();
  throw new Error("next build failed");
}
const server = spawn(process.execPath, [next, "start", "-p", String(PORT), "-H", "127.0.0.1"], { cwd: root, env, stdio: "ignore" });
const stop = async () => {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"]);
  else server.kill("SIGTERM");
  await mock.close();
};

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${SITE}/`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  const sizeOf = (file) => {
    const bytes = readFileSync(file);
    return { raw: bytes.length, gzip: gzipSync(bytes).length };
  };
  const sum = (list) => list.reduce((a, s) => ({ raw: a.raw + s.raw, gzip: a.gzip + s.gzip }), { raw: 0, gzip: 0 });
  const html = await (await fetch(`${SITE}/`)).text();
  const srcs = [...new Set([...html.matchAll(/<script[^>]+src="(\/_next\/static\/[^"]+\.js[^"]*)"/g)].map((m) => decodeURIComponent(m[1].split("?")[0])))];
  const homepage = sum(srcs.map((s) => sizeOf(join(root, ".next", s.replace("/_next/", "")))));
  const chunksDir = join(root, ".next", "static", "chunks");
  const all = readdirSync(chunksDir, { recursive: true }).filter((f) => String(f).endsWith(".js")).map((f) => sizeOf(join(chunksDir, String(f))));
  // Chunks that load on demand: the syntax highlighter (when a code block appears), the Write story reader (when one is opened).
  const named = (needle) => sum(readdirSync(chunksDir, { recursive: true }).filter((f) => String(f).endsWith(".js") && readFileSync(join(chunksDir, String(f)), "utf8").includes(needle)).map((f) => sizeOf(join(chunksDir, String(f)))));
  const onHomepage = (needle) => srcs.some((s) => readFileSync(join(root, ".next", s.replace("/_next/", "")), "utf8").includes(needle));
  console.log(JSON.stringify({ homepageScripts: srcs.length, homepage, allClientChunks: { files: all.length, ...sum(all) }, highlighterChunk: { ...named("hljs-"), onHomepage: onHomepage("hljs-") }, writeReaderChunk: { ...named("Sign in with your company email"), onHomepage: onHomepage("Sign in with your company email") } }));
  void statSync;
} finally {
  await stop();
}
process.exit(0);
