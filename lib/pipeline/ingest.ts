import "server-only";
import { env } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { planInserts, selectFeedItems } from "@/lib/ingest/dedupe";
import { extractArticleText } from "@/lib/ingest/extract";
import { createRobotsChecker, fetchText, type FetchOptions } from "@/lib/ingest/fetch";
import { parseFeed, type FeedItem } from "@/lib/ingest/rss";

export type Source = { id: string; name: string; rss_url: string; department_id: string };

export type IngestCounts = {
  fetched: number; // items read from feeds
  inserted: number;
  duplicates: number;
  failed: number; // failed feeds + failed item inserts
  deferred: number; // new items not stored this run (over MAX_ITEMS_PER_FEED, or the time ran out): left for the next run
  tooOld: number; // older than MAX_ITEM_AGE_DAYS: not stored
  fullText: number; // inserted items with page text extracted
  sourcesDeferred: number; // feeds not read at all because the time ran out
};

export type SourceReport = { source: string } & Partial<IngestCounts> & { error?: string; timeUp?: boolean };

export type IngestResult = {
  totals: IngestCounts;
  sources: SourceReport[];
  /** "time_budget" when the deadline ended the run early: what was left is in `deferred` and `sourcesDeferred`. */
  stopped: "time_budget" | null;
};

export type IngestOptions = {
  /** Epoch ms after which no new feed or page is requested (STAGE_TIME_BUDGET_MS, set by the stage runner). */
  deadlineAt?: number | null;
  now?: () => number;
};

export type NewRawItem = {
  source_id: string;
  department_id: string;
  url: string;
  title: string;
  content: string;
  full_text: string | null;
  source_published_at: string | null;
};

/** Everything runIngest reaches outside itself, so the time budget can be tested without a network or database. */
export type IngestDeps = {
  sources: () => Promise<Source[]>;
  /** Which of these URLs are already stored. */
  existingUrls: (urls: string[]) => Promise<string[]>;
  /** Stores an item; false when its URL was stored meanwhile (a concurrent run). */
  insertItem: (item: NewRawItem) => Promise<boolean>;
  fetchText: typeof fetchText;
  robotsAllowed: (url: string) => Promise<boolean>;
};

const SOURCE_CONCURRENCY = 4;
/** A request never gets less time than this, even when the deadline is near. */
const MIN_REQUEST_MS = 1000;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

const supabaseDeps = (opts: FetchOptions): IngestDeps => ({
  async sources() {
    const { data, error } = await supabaseAdmin().from("sources").select("id, name, rss_url, department_id").eq("active", true);
    if (error) throw new Error(`Loading sources failed: ${error.message}`);
    return (data ?? []) as Source[];
  },
  async existingUrls(urls) {
    const { data, error } = await supabaseAdmin().from("raw_items").select("url").in("url", urls);
    if (error) throw new Error(`dedupe lookup: ${error.message}`);
    return (data ?? []).map((r) => r.url as string);
  },
  async insertItem(item) {
    // ignoreDuplicates covers a URL inserted by a concurrent run since the lookup.
    const { data, error } = await supabaseAdmin().from("raw_items").upsert(item, { onConflict: "url", ignoreDuplicates: true }).select("id");
    if (error) throw new Error(error.message);
    return Boolean(data && data.length > 0);
  },
  fetchText,
  robotsAllowed: createRobotsChecker(opts),
});

type Context = {
  limit: number;
  maxAgeDays: number;
  opts: FetchOptions;
  deps: IngestDeps;
  timeUp: () => boolean;
  /** Request options whose timeout does not run past the deadline. */
  within: (o: FetchOptions) => FetchOptions;
};

/** Page text if robots.txt allows it and extraction works; otherwise null (RSS summary is used). */
async function fetchFullText(item: FeedItem, ctx: Context): Promise<string | null> {
  try {
    if (!(await ctx.deps.robotsAllowed(item.url))) return null;
    const html = await ctx.deps.fetchText(item.url, ctx.within({ ...ctx.opts, accept: "text/html" }));
    return extractArticleText(html);
  } catch {
    return null;
  }
}

async function ingestSource(source: Source, ctx: Context): Promise<SourceReport> {
  // The time may already be gone when this feed's turn comes (feeds are read four at a time).
  if (ctx.timeUp()) return { source: source.name, sourcesDeferred: 1, timeUp: true };

  let items: FeedItem[];
  try {
    const xml = await ctx.deps.fetchText(
      source.rss_url,
      ctx.within({ ...ctx.opts, accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" }),
    );
    items = parseFeed(xml, source.rss_url);
  } catch (err) {
    return { source: source.name, failed: 1, error: `feed: ${message(err)}` };
  }

  const fetched = items.length;
  // Newest first and nothing past MAX_ITEM_AGE_DAYS, so the per-feed cap below keeps the newest items.
  const selection = selectFeedItems(items, ctx.maxAgeDays);
  items = selection.items;

  const report: SourceReport & IngestCounts = {
    source: source.name,
    fetched,
    inserted: 0,
    duplicates: 0,
    failed: 0,
    deferred: 0,
    tooOld: selection.tooOld,
    fullText: 0,
    sourcesDeferred: 0,
  };
  if (items.length === 0) return report;

  let existing: string[];
  try {
    existing = await ctx.deps.existingUrls(items.map((i) => i.url));
  } catch (err) {
    return { ...report, failed: 1, error: message(err) };
  }

  const plan = planInserts(items, existing, ctx.limit);
  report.duplicates = plan.duplicates;
  report.deferred = plan.deferred;

  for (const [i, item] of plan.toInsert.entries()) {
    if (ctx.timeUp()) {
      // Not stored, so the next run finds them as new again.
      report.deferred += plan.toInsert.length - i;
      report.timeUp = true;
      break;
    }
    try {
      const fullText = await fetchFullText(item, ctx);
      const inserted = await ctx.deps.insertItem({
        source_id: source.id,
        department_id: source.department_id,
        url: item.url,
        title: item.title,
        content: item.content,
        full_text: fullText,
        source_published_at: item.publishedAt,
      });
      if (inserted) {
        report.inserted++;
        if (fullText) report.fullText++;
      } else {
        report.duplicates++;
      }
    } catch (err) {
      report.failed++;
      report.error = `item ${item.url}: ${message(err)}`;
    }
  }
  return report;
}

/**
 * Reads every active feed and stores the new items. Like the other stages it stops starting new work at
 * `deadlineAt`, and says what it left for the next run: `deferred` items and `sourcesDeferred` feeds.
 */
export async function runIngest(options: IngestOptions = {}, overrides: Partial<IngestDeps> = {}): Promise<IngestResult> {
  const e = env();
  const now = options.now ?? Date.now;
  const deadlineAt = options.deadlineAt ?? null;
  const opts: FetchOptions = { userAgent: e.FETCH_USER_AGENT, timeoutMs: e.FETCH_TIMEOUT_MS };
  const deps: IngestDeps = { ...supabaseDeps(opts), ...overrides };

  const ctx: Context = {
    limit: e.MAX_ITEMS_PER_FEED,
    maxAgeDays: e.MAX_ITEM_AGE_DAYS,
    opts,
    deps,
    timeUp: () => deadlineAt !== null && now() >= deadlineAt,
    within: (o) => (deadlineAt === null ? o : { ...o, timeoutMs: Math.max(MIN_REQUEST_MS, Math.min(o.timeoutMs, deadlineAt - now())) }),
  };

  const sources = await deps.sources();
  const reports = await mapLimit(sources, SOURCE_CONCURRENCY, (s) =>
    ingestSource(s, ctx).catch((err): SourceReport => ({ source: s.name, failed: 1, error: message(err) })),
  );

  const totals: IngestCounts = { fetched: 0, inserted: 0, duplicates: 0, failed: 0, deferred: 0, tooOld: 0, fullText: 0, sourcesDeferred: 0 };
  for (const r of reports) {
    for (const key of Object.keys(totals) as (keyof IngestCounts)[]) totals[key] += r[key] ?? 0;
  }
  return { totals, sources: reports, stopped: reports.some((r) => r.timeUp) ? "time_budget" : null };
}
