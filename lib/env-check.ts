// Startup check of the environment (DEP-04 / DEP-02 / DEP-03 hardening). Pure: it reads the values it is given.
// Used by instrumentation.ts (fails the boot with a clear message), by `npm run check-env`, and by tests.
import { isOpenAICompatible, OPENAI_COMPATIBLE_PROVIDERS, type ProviderName } from "@/lib/config";
import { emailProvider, graphConfig, smtpConfig } from "@/lib/mail/config";
import { schema, type Env } from "./env-schema";

type Source = Record<string, string | undefined>;

export type EnvReport = { errors: string[]; warnings: string[] };

const blank = (v: string | undefined) => v === undefined || v.trim() === "";

/** How to write a password that contains #, $, spaces or quotes in a .env file. */
export const QUOTING_RULE =
  "In .env files, put a value that contains #, $ or spaces in single quotes, for example SMTP_PASS='p#ss$word'. Unquoted, # starts a comment (the value becomes empty or truncated) and $ is expanded as a variable. In Vercel's dashboard paste the value as it is, without quotes.";

// ---------------------------------------------------------------------------
// Production checks (DEP-01 to DEP-04): `npm run check-env -- --production`
// ---------------------------------------------------------------------------

/** Mailboxes people use privately: an admin of the company newsroom should not sign in with one. */
const PERSONAL_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com", "icloud.com", "me.com",
  "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.net", "mail.com", "zoho.com",
]);

const PLACEHOLDER_DOMAIN = /(^|\.)(example\.(com|org|net)|test\.com|localhost|invalid|yourcompany\.com|your-company\.com|company\.com|domain\.com|email\.com)$/i;
const PLACEHOLDER_LOCAL = /^(test|testing|demo|changeme|change-me|you|yourname|your[-_.]?email|name|user)$/i;

/** Why an ADMIN_EMAILS entry should not be there in production, or null when it looks fine. */
export function adminEmailProblem(email: string, companyDomains: readonly string[]): string | null {
  const at = email.lastIndexOf("@");
  const local = at > 0 ? email.slice(0, at) : email;
  const domain = at > 0 ? email.slice(at + 1).toLowerCase() : "";
  if (PLACEHOLDER_DOMAIN.test(domain) || PLACEHOLDER_LOCAL.test(local)) return "looks like a placeholder or test address";
  if (PERSONAL_MAIL_DOMAINS.has(domain)) return "is a personal mailbox";
  if (companyDomains.length > 0 && !companyDomains.some((d) => domain === d || domain.endsWith(`.${d}`))) {
    return `is outside the company domains (${companyDomains.join(", ")})`;
  }
  return null;
}

/** Keys that exist in the environment but that nothing in the app reads. */
const KNOWN_UNUSED = ["PEXELS_API_KEY"];
/** Names the app and its platform use without them being in the schema. */
const OTHER_KNOWN = new Set([
  "NODE_ENV", "APP_URL", "EMAIL_PROVIDER", "MAIL_FROM", "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "MS_TENANT_ID", "MS_CLIENT_ID", "MS_CLIENT_SECRET",
]);
const SECRET_LIKE = /(_KEY|_SECRET|_TOKEN|_PASS|_PASSWORD)$/i;

/** The providers write and fact-check use, and the variable that chose each. */
function stageProviders(e: Env): { variable: string; stage: string; provider: ProviderName }[] {
  return [
    { variable: e.WRITE_LLM_PROVIDER ? "WRITE_LLM_PROVIDER" : "LLM_PROVIDER", stage: "write", provider: e.WRITE_LLM_PROVIDER ?? e.LLM_PROVIDER },
    { variable: e.FACTCHECK_LLM_PROVIDER ? "FACTCHECK_LLM_PROVIDER" : "LLM_PROVIDER", stage: "fact-check", provider: e.FACTCHECK_LLM_PROVIDER ?? e.LLM_PROVIDER },
  ];
}

/** The names defined in the text of a .env file (comments and blank lines skipped). */
export function envFileKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m) keys.add(m[1]);
  }
  return [...keys];
}

export type ValidateOptions = {
  /** The stricter launch checks. */
  production?: boolean;
  /** Names defined in the project's .env files: a secret-looking name nothing reads is reported as unused. */
  fileKeys?: string[];
};

function productionChecks(source: Source, e: Env, fileKeys: string[], errors: string[], warnings: string[]) {
  // The site address: digest links and the privacy notice point at it.
  if (!e.SITE_URL) errors.push("SITE_URL is required in production: it is the public https address used in the digest email's links.");
  else {
    const url = new URL(e.SITE_URL);
    if (url.protocol !== "https:") errors.push(`SITE_URL must be an https address in production (it is ${url.protocol}//${url.host}).`);
    if (/^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.)/i.test(url.hostname)) errors.push(`SITE_URL points at ${url.host}, which readers cannot reach. Use the public address.`);
  }
  if (/^https?:\/\/(localhost|127\.|0\.0\.0\.0)/i.test(source.NEXT_PUBLIC_SUPABASE_URL ?? "")) {
    errors.push("NEXT_PUBLIC_SUPABASE_URL points at this computer: use the production Supabase project.");
  }

  // Who may submit and who may administer.
  if (e.ALLOWED_EMAIL_DOMAINS.length === 0) errors.push("ALLOWED_EMAIL_DOMAINS is required in production: without it /submit accepts any email address.");
  if (e.ADMIN_EMAILS.length === 0) errors.push("ADMIN_EMAILS is required in production: nobody could sign in to /admin.");
  for (const admin of e.ADMIN_EMAILS) {
    const why = adminEmailProblem(admin, e.ALLOWED_EMAIL_DOMAINS);
    if (why) errors.push(`ADMIN_EMAILS: ${admin} ${why}. Use each administrator's company address.`);
  }

  // Secrets.
  if (e.CRON_SECRET.length < 32) errors.push(`CRON_SECRET has ${e.CRON_SECRET.length} characters; use at least 32 random ones in production (it also signs the admin session cookie).`);

  // /submit.
  if (!e.PRIVACY_CONTACT) errors.push("PRIVACY_CONTACT is required in production: it is the address /submit gives for asking to see or delete one's data.");

  // Mail: with no provider the digest cannot be sent and no alert email goes out.
  if (blank(source.EMAIL_PROVIDER) || source.EMAIL_PROVIDER?.trim().toLowerCase() === "none") {
    warnings.push("EMAIL_PROVIDER is none: the weekly digest cannot be sent, no failure alert is emailed (the banner on /admin still works), and readers cannot sign in to like or comment on Write stories (they get a code by email).");
  }

  // Things that should not be here.
  if (!blank(source.APP_URL)) errors.push("APP_URL is only for running scripts against a local server (npm run stage). Remove it from the production environment.");
  for (const key of KNOWN_UNUSED) {
    if (!blank(source[key]) || fileKeys.includes(key)) errors.push(`${key} is set but the app does not use it. Remove it.`);
  }
  const known = new Set<string>([...Object.keys(schema.shape), ...OTHER_KNOWN, ...KNOWN_UNUSED]);
  for (const key of fileKeys) {
    if (!known.has(key) && SECRET_LIKE.test(key) && !key.startsWith("NEXT_PUBLIC_")) errors.push(`${key} is defined in a .env file but the app does not read it. Remove it.`);
  }
  const other = e.LLM_PROVIDER === "gemini" ? "anthropic" : "gemini";
  const otherLlm = other === "gemini" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY";
  if (!blank(source[otherLlm]) && !stageProviders(e).some((s) => s.provider === other)) {
    warnings.push(`${otherLlm} is set but LLM_PROVIDER=${e.LLM_PROVIDER}: it is not used. Remove it unless you plan to switch.`);
  }

  if (cspModeOf(source) === "report-only") {
    warnings.push("CSP_MODE is report-only: the Content-Security-Policy only reports violations. After a few days without reports set CSP_MODE=enforce and deploy again.");
  }
}

const cspModeOf = (source: Source) => (source.CSP_MODE?.trim().toLowerCase() === "enforce" ? "enforce" : "report-only");

/** Missing or invalid settings are errors (the app must not start); risky but workable ones are warnings. */
export function validateEnv(source: Source = process.env, options: ValidateOptions = {}): EnvReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. The core schema (Supabase, secrets, limits, domains).
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const name = String(issue.path[0] ?? "environment");
      errors.push(blank(source[name]) ? `${name} is required but not set.` : `${name}: ${issue.message}`);
    }
  }

  // 2. Mail, only for the provider in use.
  let provider: "smtp" | "graph" | "none" = "none";
  try {
    provider = emailProvider(source);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  if (provider === "smtp") {
    for (const name of ["SMTP_HOST", "SMTP_USER", "MAIL_FROM"]) {
      if (blank(source[name])) errors.push(`${name} is required when EMAIL_PROVIDER=smtp.`);
    }
    if (blank(source.SMTP_PASS)) errors.push(`SMTP_PASS is empty while EMAIL_PROVIDER=smtp. ${QUOTING_RULE}`);
    if (!errors.some((e) => /^(SMTP_|MAIL_FROM)/.test(e))) {
      try {
        smtpConfig(source);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
  } else if (provider === "graph") {
    for (const name of ["MS_TENANT_ID", "MS_CLIENT_ID", "MS_CLIENT_SECRET", "MAIL_FROM"]) {
      if (blank(source[name])) errors.push(`${name} is required when EMAIL_PROVIDER=graph.`);
    }
    if (!errors.some((e) => /^(MS_|MAIL_FROM)/.test(e))) {
      try {
        graphConfig(source);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
  }

  // 3. Settings that work but are probably not what you want.
  if (parsed.success) {
    const e = parsed.data;
    if (e.ADMIN_EMAILS.length === 0) warnings.push("ADMIN_EMAILS is empty: nobody can sign in to /admin.");
    if (e.ALLOWED_EMAIL_DOMAINS.length === 0) warnings.push("ALLOWED_EMAIL_DOMAINS is empty: /submit accepts any email address (stories are flagged unverified).");
    if (!e.SITE_URL) warnings.push("SITE_URL is not set: links in the weekly digest use a placeholder address.");
    else if (source.NODE_ENV === "production" && /^https?:\/\/(localhost|127\.|0\.0\.0\.0)/i.test(e.SITE_URL)) {
      warnings.push(`SITE_URL points at ${new URL(e.SITE_URL).host} in production: digest links would not work for readers.`);
    }
    const llmKey = e.LLM_PROVIDER === "gemini" ? e.GEMINI_API_KEY : e.ANTHROPIC_API_KEY;
    if (e.TURNSTILE_SITE_KEY && !e.TURNSTILE_SECRET) errors.push("TURNSTILE_SITE_KEY is set but TURNSTILE_SECRET is not: set both to turn the check on, or neither.");
    if (e.TURNSTILE_SECRET && !e.TURNSTILE_SITE_KEY) errors.push("TURNSTILE_SECRET is set but TURNSTILE_SITE_KEY is not: set both to turn the check on, or neither.");
    if (!llmKey) warnings.push(`${e.LLM_PROVIDER === "gemini" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY"} is not set but LLM_PROVIDER=${e.LLM_PROVIDER}: classify, write and fact-check will fail.`);
    // Write and fact-check on their own provider (WRITE_LLM_PROVIDER, FACTCHECK_LLM_PROVIDER).
    for (const { variable, stage, provider } of stageProviders(e)) {
      if (provider === e.LLM_PROVIDER) continue;
      const needed = isOpenAICompatible(provider)
        ? [OPENAI_COMPATIBLE_PROVIDERS[provider].apiKeyEnv, OPENAI_COMPATIBLE_PROVIDERS[provider].modelEnv]
        : [provider === "gemini" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY"];
      for (const name of needed) if (blank(source[name])) warnings.push(`${name} is not set but ${variable}=${provider}: the ${stage} stage will fail.`);
    }
  }
  // A secret in a NEXT_PUBLIC_ variable would be sent to every visitor's browser.
  for (const key of Object.keys(source)) {
    if (key.startsWith("NEXT_PUBLIC_") && /SERVICE_ROLE|SECRET|PASS|PRIVATE/i.test(key) && !blank(source[key])) {
      errors.push(`${key} starts with NEXT_PUBLIC_, so it would be published to every visitor. Rename it without the prefix.`);
    }
  }

  if (options.production && parsed.success) productionChecks(source, parsed.data, options.fileKeys ?? [], errors, warnings);
  return { errors, warnings };
}

export type DuplicateKey = { key: string; lines: number[] };

/** Keys that appear more than once in the text of a .env file. The loader keeps the LAST one, silently. */
export function findDuplicateKeys(text: string): DuplicateKey[] {
  const seen = new Map<string, number[]>();
  text.split(/\r?\n/).forEach((line, i) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m) seen.set(m[1], [...(seen.get(m[1]) ?? []), i + 1]);
  });
  return [...seen].filter(([, lines]) => lines.length > 1).map(([key, lines]) => ({ key, lines }));
}

/** Warning lines for duplicate keys in a named file. */
export function duplicateKeyWarnings(file: string, text: string): string[] {
  return findDuplicateKeys(text).map(
    ({ key, lines }) => `${key} is defined ${lines.length} times in ${file} (lines ${lines.join(", ")}). Only the last one is used; delete the others.`,
  );
}

/** A readable block for the terminal or the error message. */
export function formatReport(report: EnvReport): string {
  const parts: string[] = [];
  if (report.errors.length) parts.push(`Environment problems (fix these, then restart):\n${report.errors.map((e) => `  - ${e}`).join("\n")}`);
  if (report.warnings.length) parts.push(`Warnings:\n${report.warnings.map((w) => `  - ${w}`).join("\n")}`);
  return parts.join("\n\n");
}
