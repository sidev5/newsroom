import "server-only";
import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { hashIp } from "./identity";
import { turnstileConfig, verifyTurnstile } from "./turnstile";
import type { SubmissionDeps } from "./service";
import { supabaseSubmissionStore } from "./store";

/** The real dependencies of the submit action. Throws if the environment is invalid (the caller turns that into a plain error). */
export function submissionDeps(): SubmissionDeps {
  const e = env();
  // A dedicated secret if one is set, else the cron secret: either way the stored hash cannot be reversed without it.
  const secret = e.SUBMISSION_HASH_SALT ?? e.CRON_SECRET;
  const captcha = turnstileConfig(process.env);
  return {
    store: supabaseSubmissionStore(),
    allowedDomains: e.ALLOWED_EMAIL_DOMAINS,
    hashIp: (ip) => hashIp(ip, secret),
    now: () => new Date(),
    newId: () => randomUUID(),
    ...(captcha ? { captcha: (token: string | null, ip: string | null) => verifyTurnstile({ secret: captcha.secret, token, ip }) } : {}),
  };
}
