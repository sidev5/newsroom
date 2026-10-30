const DAY_MS = 24 * 60 * 60 * 1000;

/** True if the source was published more than maxAgeDays ago. Unknown dates are not "too old". */
export function isTooOld(publishedAt: string | null | undefined, maxAgeDays: number, now: Date = new Date()): boolean {
  if (!publishedAt) return false;
  const t = new Date(publishedAt).getTime();
  return Number.isFinite(t) && now.getTime() - t > maxAgeDays * DAY_MS;
}

/** "12 October 2026" (UTC, so server and viewer agree), or null when there is no date. */
export function formatSourceDate(publishedAt: string | null | undefined): string | null {
  if (!publishedAt) return null;
  const d = new Date(publishedAt);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** Text for the article page and review screen. Pair it with a link to the source URL. */
export function sourceAttribution(publishedAt: string | null | undefined): string {
  const date = formatSourceDate(publishedAt);
  return date ? `Based on a source published ${date}` : "Based on a source (publication date unknown)";
}

/**
 * Extra rules for the fact-check prompt (stage 5, not built yet): include this block in its system prompt.
 */
export const FACTCHECK_FRESHNESS_RULES = `Also flag these problems:
- Current-status claims without a date: any statement that something is, remains, still holds or is currently the case, unless it is tied to a date such as "as of <source date>" or "at the time of publication".
- Claims not directly stated in the source: anything the source does not say in so many words, including generalising from one market, country, company or product to another, or turning a single data point into a trend.`;
