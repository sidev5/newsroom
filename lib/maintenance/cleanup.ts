import { PRIVACY_RETENTION, RETENTION } from "@/lib/config";

// DB-03 and SEC-13: retention. The three deletions run inside one Postgres function (public.run_retention, created by
// supabase/migrations/2026-10-19_reliability.sql), because "an item with no article" is a NOT EXISTS the REST API cannot
// express and because one transaction keeps the counts honest. This module is the caller: it passes the periods
// from lib/config.ts, defaults to a dry run, and logs how many rows each step touched.

export type CleanupCounts = {
  /** raw_items.full_text set to null: items written or skipped more than FULL_TEXT_DAYS ago. */
  full_text_cleared: number;
  /** raw_items older than RAW_ITEM_DAYS with no article. */
  raw_items_deleted: number;
  /** agent_runs older than RUN_LOG_MONTHS. */
  agent_runs_deleted: number;
  /** pipeline_runs older than RUN_LOG_MONTHS. */
  pipeline_runs_deleted: number;
};

/** What the privacy rules (SEC-13) touched. */
export type PrivacyCounts = {
  /** article_submitters.ip_hash set to null: submitted more than IP_HASH_DAYS ago. */
  ip_hash_cleared: number;
  /** Submitter emails replaced by an anonymous placeholder: the article was decided more than EMAIL_DAYS ago. */
  emails_anonymized: number;
  /** Private-bucket photo files of those submitters (removed from storage before the emails are anonymized). */
  photo_paths: string[];
};

export type CleanupResult = CleanupCounts & {
  ip_hash_cleared: number;
  emails_anonymized: number;
  /** Photo files removed from the private bucket (with a dry run: that would be removed). */
  photos_removed: number;
  /** false: nothing was changed, the counts are what an apply would touch. */
  apply: boolean;
  /** The periods used, for the log. */
  retention: { fullTextDays: number; rawItemDays: number; runLogMonths: number; ipHashDays: number; emailDays: number };
};

export interface CleanupStore {
  /** Calls the database function. With apply=false it only counts. */
  retention(args: { apply: boolean; fullTextDays: number; rawItemDays: number; runLogMonths: number; now: Date }): Promise<CleanupCounts>;
  /** Calls public.run_privacy_retention. With apply=false it only counts and lists the photo paths. */
  privacy(args: { apply: boolean; ipDays: number; emailDays: number; now: Date }): Promise<PrivacyCounts>;
  /** Removes files from the private submission-images bucket. `failed` counts the ones that could not be removed. */
  removePrivatePhotos(paths: string[]): Promise<{ removed: number; failed: number }>;
}

const MISSING = "The retention function is missing. Run supabase/migrations/2026-10-19_reliability.sql and supabase/migrations/2026-10-20_privacy_and_hardening.sql in the Supabase SQL editor.";

/** Turns a missing-function error from PostgREST into the instruction that fixes it. */
export function describeCleanupError(message: string): string {
  return /run_retention|run_privacy_retention|schema cache|could not find the function|42883/i.test(message) ? MISSING : message;
}

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number.isFinite(Number(v)) ? Number(v) : 0);

export function parsePrivacy(raw: unknown): PrivacyCounts {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    ip_hash_cleared: count(r.ip_hash_cleared),
    emails_anonymized: count(r.emails_anonymized),
    photo_paths: Array.isArray(r.photo_paths) ? r.photo_paths.filter((p): p is string => typeof p === "string" && p.length > 0) : [],
  };
}

export function parseCounts(raw: unknown): CleanupCounts {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    full_text_cleared: count(r.full_text_cleared),
    raw_items_deleted: count(r.raw_items_deleted),
    agent_runs_deleted: count(r.agent_runs_deleted),
    pipeline_runs_deleted: count(r.pipeline_runs_deleted),
  };
}

/** One line for the log. */
export function formatCleanup(r: CleanupResult): string {
  const verb = r.apply ? "applied" : "dry run, nothing changed";
  return (
    `cleanup (${verb}): full_text cleared on ${r.full_text_cleared} raw items (written/skipped, over ${r.retention.fullTextDays} days old); ` +
    `${r.raw_items_deleted} raw items with no article deleted (over ${r.retention.rawItemDays} days old); ` +
    `${r.agent_runs_deleted} agent_runs and ${r.pipeline_runs_deleted} pipeline_runs deleted (over ${r.retention.runLogMonths} months old); ` +
    `privacy: ip_hash cleared on ${r.ip_hash_cleared} submissions (over ${r.retention.ipHashDays} days old), ` +
    `${r.emails_anonymized} submitter emails anonymized (decision over ${r.retention.emailDays} days ago), ${r.photos_removed} private photos removed`
  );
}

/**
 * Applies the retention rules, or with `apply: false` (the default) only counts what they would touch.
 * Logs the counts either way.
 */
export async function runCleanup(
  opts: { apply?: boolean; now?: Date; log?: (line: string) => void; ipHashDays?: number; emailDays?: number } = {},
  store?: CleanupStore,
): Promise<CleanupResult> {
  const apply = opts.apply === true;
  const log = opts.log ?? console.log;
  const retention = {
    fullTextDays: RETENTION.FULL_TEXT_DAYS,
    rawItemDays: RETENTION.RAW_ITEM_DAYS,
    runLogMonths: RETENTION.RUN_LOG_MONTHS,
    ipHashDays: opts.ipHashDays ?? PRIVACY_RETENTION.IP_HASH_DAYS,
    emailDays: opts.emailDays ?? PRIVACY_RETENTION.EMAIL_DAYS,
  };
  const db = store ?? (await import("./cleanup-store")).supabaseCleanupStore();

  const now = opts.now ?? new Date();
  let counts: CleanupCounts;
  let privacy: PrivacyCounts;
  let photosRemoved = 0;
  try {
    counts = await db.retention({ apply, fullTextDays: retention.fullTextDays, rawItemDays: retention.rawItemDays, runLogMonths: retention.runLogMonths, now });
    // Counts first (nothing changes), so the photos can be removed BEFORE the rows that point at them are cleared.
    privacy = await db.privacy({ apply: false, ipDays: retention.ipHashDays, emailDays: retention.emailDays, now });
    photosRemoved = privacy.photo_paths.length;
    if (apply) {
      if (privacy.photo_paths.length > 0) {
        const removal = await db.removePrivatePhotos(privacy.photo_paths);
        if (removal.failed > 0) {
          throw new Error(`${removal.failed} private photos could not be removed from storage, so no submitter email was anonymized this time. Check the storage settings and run the cleanup again.`);
        }
        photosRemoved = removal.removed;
      }
      privacy = await db.privacy({ apply: true, ipDays: retention.ipHashDays, emailDays: retention.emailDays, now });
    }
  } catch (err) {
    throw new Error(describeCleanupError(err instanceof Error ? err.message : String(err)));
  }
  const result: CleanupResult = {
    apply,
    ...counts,
    ip_hash_cleared: privacy.ip_hash_cleared,
    emails_anonymized: privacy.emails_anonymized,
    photos_removed: photosRemoved,
    retention,
  };
  log(formatCleanup(result));
  return result;
}
