import { SUBMISSION_LIMITS } from "@/lib/config";
import { titleKey } from "./text";

// Abuse rules for /submit. Pure: the service counts, this decides.

export type LimitCounts = {
  /** Submissions from this IP hash in the last 24 hours (null: the address was unknown, so no IP rule applies). */
  ip: number | null;
  /** Submissions with this email in the last 24 hours. */
  email: number;
};

export type LimitDecision = { ok: true } | { ok: false; reason: "duplicate" | "email" | "ip"; message: string };

export const DUPLICATE_MESSAGE = `You already sent a story with this title in the last ${SUBMISSION_LIMITS.DUPLICATE_WINDOW_HOURS} hours, so it is already waiting for review. If this is a different story, give it a different title.`;
export const EMAIL_LIMIT_MESSAGE = `This email address has already sent ${SUBMISSION_LIMITS.MAX_PER_EMAIL_PER_DAY} stories today. Please try again tomorrow.`;
export const IP_LIMIT_MESSAGE = `Too many stories have been sent from this connection today (the limit is ${SUBMISSION_LIMITS.MAX_PER_IP_PER_DAY}). Please try again tomorrow.`;

/** True when the same title (ignoring case and spacing) was already sent by this email in the window. */
export function isDuplicate(title: string, recentTitles: readonly string[]): boolean {
  const key = titleKey(title);
  return recentTitles.some((t) => titleKey(t) === key);
}

/** Duplicate first (the most specific message), then the per-email and per-IP daily limits. */
export function decideLimits(input: { counts: LimitCounts; title: string; recentTitles: readonly string[] }): LimitDecision {
  if (isDuplicate(input.title, input.recentTitles)) return { ok: false, reason: "duplicate", message: DUPLICATE_MESSAGE };
  if (input.counts.email >= SUBMISSION_LIMITS.MAX_PER_EMAIL_PER_DAY) return { ok: false, reason: "email", message: EMAIL_LIMIT_MESSAGE };
  if (input.counts.ip !== null && input.counts.ip >= SUBMISSION_LIMITS.MAX_PER_IP_PER_DAY) return { ok: false, reason: "ip", message: IP_LIMIT_MESSAGE };
  return { ok: true };
}

/** Start of the rolling window that the counts and the duplicate check look at. */
export function windowStart(now: Date, hours: number = 24): string {
  return new Date(now.getTime() - hours * 3_600_000).toISOString();
}
