/** Fixed format, identical on server and client: 2026-10-12. */
export function isoDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** "5M AGO", "3H AGO", "2D AGO", else the ISO date. Call only on the client after mount. */
export function relativeTime(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const mins = Math.floor((nowMs - t) / 60_000);
  if (mins < 1) return "JUST NOW";
  if (mins < 60) return `${mins}M AGO`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}H AGO`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}D AGO`;
  return isoDate(iso) ?? "";
}

/** "www.reuters.com" -> "reuters.com". Empty string for a URL that doesn't parse. */
export function sourceName(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Only web links are opened from stored data. */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Path of the public bucket that holds the photos of published employee stories (see STORAGE_BUCKETS). */
export const PUBLIC_IMAGE_PATH = "/storage/v1/object/public/article-images/";

/** Hostname of the Supabase project (NEXT_PUBLIC_ variables are inlined into the browser bundle), or null when unset. */
function supabaseHost(): string | null {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").hostname;
  } catch {
    return null;
  }
}

/**
 * next/image only renders the hosts listed in next.config.ts: images.unsplash.com, and the public
 * article-images bucket of this Supabase project. Anything else gets the department default.
 */
export function allowedImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    if (u.hostname === "images.unsplash.com") return u.toString();
    const own = supabaseHost();
    return own && u.hostname === own && u.pathname.startsWith(PUBLIC_IMAGE_PATH) ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Card summary: the start of the body, cut at a word boundary. */
export function summarize(body: string, max = 150): string {
  const text = body.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/** Length of the stored summary (`articles.summary`) that the feed cards show. */
export const SUMMARY_CHARS = 240;

/** The value stored in `articles.summary`. The SQL backfill in supabase/migrations/2026-10-18_article_summary.sql does the same. */
export function makeSummary(body: string): string {
  return summarize(body, SUMMARY_CHARS);
}

export function paragraphs(body: string): string[] {
  return body.split(/\n\s*\n|\n/).map((p) => p.trim()).filter(Boolean);
}
