// npm run check-env: validates .env.local (and the process environment) the same way the server does at boot,
// and warns about keys defined more than once. Exit code 1 if anything blocks the boot.
// npm run check-env -- --production  adds the launch checks: https SITE_URL, ALLOWED_EMAIL_DOMAINS, company-only
// ADMIN_EMAILS, a 32-character CRON_SECRET, PRIVACY_CONTACT, and no unused keys (PEXELS_API_KEY and the like).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvConfig } from "@next/env";
import { duplicateKeyWarnings, envFileKeys, formatReport, validateEnv } from "../lib/env-check";

const cwd = process.cwd();
// Loads .env, .env.local, ... exactly like Next does (without overriding variables that are already set).
const production = process.argv.slice(2).includes("--production");
const unknown = process.argv.slice(2).filter((a) => a !== "--production");
if (unknown.length > 0) {
  console.error(`Unknown option: ${unknown.join(" ")}. Usage: npm run check-env [-- --production]`);
  process.exit(1);
}
loadEnvConfig(cwd, !production && process.env.NODE_ENV !== "production");

// The names in the project's own .env files (not the whole process environment, which has many unrelated variables).
const fileKeys: string[] = [];
const texts: { file: string; text: string }[] = [];
for (const file of [".env.local", ".env", ".env.production", ".env.production.local"]) {
  const path = join(cwd, file);
  if (existsSync(path)) {
    const text = readFileSync(path, "utf8");
    texts.push({ file, text });
    fileKeys.push(...envFileKeys(text));
  }
}

const report = validateEnv(process.env, { production, fileKeys: [...new Set(fileKeys)] });
for (const { file, text } of texts) {
  if (file === ".env.local" || file === ".env") report.warnings.push(...duplicateKeyWarnings(file, text));
}

const text = formatReport(report);
if (report.errors.length > 0) {
  console.error(text);
  process.exit(1);
}
console.log(production ? "Checked for production.\n" : "");
console.log(text || "Environment OK: no problems and no warnings.");
if (text) console.log("\nEnvironment OK (with the warnings above).");
