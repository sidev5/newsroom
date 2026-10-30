// Which week a digest belongs to. Pure.

const DAY_MS = 24 * 60 * 60 * 1000;
export const DIGEST_TIME_ZONE = "Asia/Kolkata";
export const CANDIDATE_WINDOW_DAYS = 7;

/** Today's calendar date in Asia/Kolkata as YYYY-MM-DD. */
export function kolkataDate(now: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: DIGEST_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** The Monday (YYYY-MM-DD) of the week containing `now`, by the Asia/Kolkata calendar. */
export function weekStart(now: Date): string {
  const [y, m, d] = kolkataDate(now).split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d));
  const sinceMonday = (day.getUTCDay() + 6) % 7; // Monday 0 ... Sunday 6
  return new Date(day.getTime() - sinceMonday * DAY_MS).toISOString().slice(0, 10);
}

/** Start of the candidate window: stories published at or after this instant. */
export function windowStart(now: Date, days: number = CANDIDATE_WINDOW_DAYS): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/** "12 October 2026" for a YYYY-MM-DD key or any ISO date. */
export function formatLongDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}
