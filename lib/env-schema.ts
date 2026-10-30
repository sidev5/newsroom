// The environment schema, shared by the server (lib/env.ts) and the boot check (instrumentation.ts,
// scripts/check-env.ts, lib/env-check.ts). No server-only import here, so plain Node scripts can load it.
import { z } from "zod";
import { OPENAI_COMPATIBLE_PROVIDERS, PIPELINE_DEFAULTS, PRIVACY_RETENTION, PROVIDER_NAMES, TIERED_PROVIDERS } from "@/lib/config";

const boolString = z
  .enum(["true", "false"])
  .default("true")
  .transform((v) => v === "true");

/** An empty `FOO=` line in .env means "not set". */
const optional = <T extends z.ZodType>(type: T) => z.preprocess((v) => (v === "" ? undefined : v), type.optional());

/** An empty value means "use the default". */
const withDefault = <T extends z.ZodType>(type: T) => z.preprocess((v) => (v === "" ? undefined : v), type);

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** "Adorpower.com, @example.org" -> domains ["adorpower.com", "example.org"]; entries that are not a bare domain are listed in `invalid`. */
export function parseDomains(value: string): { domains: string[]; invalid: string[] } {
  const entries = value
    .split(/[,;\s]+/)
    .map((d) => d.trim().toLowerCase().replace(/^@+/, ""))
    .filter(Boolean);
  return { domains: [...new Set(entries.filter((d) => DOMAIN.test(d)))], invalid: entries.filter((d) => !DOMAIN.test(d)) };
}

type OpenAICompatibleEnvKey = { [P in keyof typeof OPENAI_COMPATIBLE_PROVIDERS]: (typeof OPENAI_COMPATIBLE_PROVIDERS)[P]["apiKeyEnv"] | (typeof OPENAI_COMPATIBLE_PROVIDERS)[P]["modelEnv"] }[keyof typeof OPENAI_COMPATIBLE_PROVIDERS];

const openAICompatibleEnv = Object.fromEntries(
  Object.values(OPENAI_COMPATIBLE_PROVIDERS).flatMap((p) => [
    [p.apiKeyEnv, optional(z.string().min(1))],
    [p.modelEnv, optional(z.string().trim().min(1))],
  ]),
) as Record<OpenAICompatibleEnvKey, ReturnType<typeof optional<z.ZodString>>>;

export const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  /** Classify's provider, and write's and fact-check's unless they have their own below. */
  LLM_PROVIDER: z.enum(TIERED_PROVIDERS).default("gemini"),
  /** Write and fact-check may use another provider, including an OpenAI-compatible free tier (OPENAI_COMPATIBLE_PROVIDERS). */
  WRITE_LLM_PROVIDER: optional(z.enum(PROVIDER_NAMES)),
  FACTCHECK_LLM_PROVIDER: optional(z.enum(PROVIDER_NAMES)),
  // Only the stages that need them check these, so earlier stages run without them.
  ANTHROPIC_API_KEY: optional(z.string().min(1)),
  GEMINI_API_KEY: optional(z.string().min(1)),
  // The key and model of each OpenAI-compatible provider (GROQ_API_KEY, GROQ_MODEL, ...), named in lib/config.ts.
  ...openAICompatibleEnv,
  IMAGE_PROVIDER: z.enum(["unsplash"]).default("unsplash"),
  UNSPLASH_ACCESS_KEY: optional(z.string().min(1)),
  CRON_SECRET: z.string().min(16, "CRON_SECRET must be at least 16 characters"),
  ADMIN_EMAILS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  BATCH_LIMIT: z.coerce.number().int().min(1).max(500).default(PIPELINE_DEFAULTS.BATCH_LIMIT),
  MAX_ITEMS_PER_FEED: z.coerce.number().int().min(1).max(100).default(PIPELINE_DEFAULTS.MAX_ITEMS_PER_FEED),
  STAGE_CHUNK_SIZE: z.coerce.number().int().min(1).max(50).default(PIPELINE_DEFAULTS.STAGE_CHUNK_SIZE),
  STAGE_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(PIPELINE_DEFAULTS.STAGE_DELAY_MS),
  STAGE_TIME_BUDGET_MS: z.coerce.number().int().min(1000).max(290_000).default(PIPELINE_DEFAULTS.STAGE_TIME_BUDGET_MS),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(280_000).default(PIPELINE_DEFAULTS.LLM_TIMEOUT_MS),
  /** Daily cap on LLM spend in USD (Asia/Kolkata day). An admin can raise today's limit from /admin. */
  DAILY_BUDGET_USD: withDefault(z.coerce.number().positive().max(100_000).default(PIPELINE_DEFAULTS.DAILY_BUDGET_USD)),
  RELEVANCE_THRESHOLD: z.coerce.number().int().min(0).max(10).default(7),
  MAX_ITEM_AGE_DAYS: z.coerce.number().int().min(1).default(3),
  KEYWORD_PRECHECK: boolString,
  MIN_SOURCE_WORDS: z.coerce.number().int().min(0).default(120),
  FETCH_USER_AGENT: z.string().min(1).default("AINewsroomBot/1.0"),
  FETCH_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  // Weekly digest. The mail provider variables are validated in lib/mail/config.ts, only when used.
  DIGEST_MAX_STORIES: z.coerce.number().int().min(1).max(12).default(6),
  /** One distribution list that receives the digest as a single message. */
  DIGEST_TO: optional(z.email()),
  /** Public URL of the dashboard, used for links in the email. */
  SITE_URL: optional(z.url()),
  /** Shown in the email footer. */
  DIGEST_CONTACT: optional(z.email()),
  // Employee submissions (/submit).
  /** Comma-separated company email domains allowed to submit (e.g. "adorpower.com"). Empty: any email is accepted but flagged unverified. */
  // A typo is an error, not an empty list: an empty list would let any email through.
  ALLOWED_EMAIL_DOMAINS: z
    .string()
    .default("")
    .transform((value, ctx) => {
      const { domains, invalid } = parseDomains(value);
      if (invalid.length) ctx.issues.push({ code: "custom", message: `not a domain: ${invalid.join(", ")}`, input: value });
      return domains;
    }),
  /** Where people send a request to see or delete their data; shown on /submit (SEC-13). */
  PRIVACY_CONTACT: optional(z.email()),
  /** Days after which the stored hash of the submitter's IP is deleted (default 7). */
  SUBMITTER_IP_RETENTION_DAYS: withDefault(z.coerce.number().int().min(1).max(3650).default(PRIVACY_RETENTION.IP_HASH_DAYS)),
  /** Days after the article's decision (published or rejected) after which the submitter's email is anonymized (default 90). */
  SUBMITTER_EMAIL_RETENTION_DAYS: withDefault(z.coerce.number().int().min(1).max(3650).default(PRIVACY_RETENTION.EMAIL_DAYS)),
  /** Content-Security-Policy mode. It is read when the app is built (next.config.ts), so changing it needs a new deployment. */
  CSP_MODE: optional(z.enum(["report-only", "enforce"])),
  /** Cloudflare Turnstile on /submit: both set turns it on, neither leaves it off. */
  TURNSTILE_SITE_KEY: optional(z.string().min(1)),
  TURNSTILE_SECRET: optional(z.string().min(1)),
  /** Secret mixed into the stored IP hash. Optional: falls back to CRON_SECRET. */
  SUBMISSION_HASH_SALT: optional(z.string().min(16, "SUBMISSION_HASH_SALT must be at least 16 characters")),
  // Admin session limits (proxy.ts and currentAdminEmail). An empty value means the default.
  /** Minutes without an admin request before the admin is signed out (default 30). */
  ADMIN_IDLE_MINUTES: withDefault(z.coerce.number().positive().max(24 * 60).default(30)),
  /** Hours after signing in at which the admin is signed out, whatever they are doing (default 8). */
  ADMIN_SESSION_HOURS: withDefault(z.coerce.number().positive().max(24 * 14).default(8)),
  /** Secret that signs the admin activity cookie. Optional: falls back to CRON_SECRET. */
  ADMIN_SESSION_SECRET: optional(z.string().min(16, "ADMIN_SESSION_SECRET must be at least 16 characters")),
});

export type Env = z.infer<typeof schema>;
