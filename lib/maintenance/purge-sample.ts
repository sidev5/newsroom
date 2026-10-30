// `npm run stage -- purge-sample [--apply]`: lists, and with --apply deletes, the test content before the pilot: sample articles,
// test submissions and placeholder sources. The selection and the deletion are one Postgres function (public.purge_sample_data, in
// supabase/migrations/2026-10-20_privacy_and_hardening.sql); this module is the caller. It removes the photo files first, then
// the rows. A dry run (the default) changes nothing. Plain module: the store is injected, and the CLI uses formatPurge.

export type SampleArticle = { id: string; headline: string; status: string; origin: "ai" | "employee" | null; image_url: string | null };
export type SampleSource = { id: string; name: string; rss_url: string };

/** What public.purge_sample_data returns. */
export type PurgeRaw = {
  apply: boolean;
  articles: SampleArticle[];
  submissions: number;
  raw_items: number;
  sources: SampleSource[];
  /** Photo files of the sample submissions in the private bucket. */
  photo_paths: string[];
  deleted: { articles: number; raw_items: number; sources: number };
};

export interface PurgeStore {
  /** Calls the database function. With apply=false nothing is deleted. */
  purge(apply: boolean): Promise<PurgeRaw>;
  /** Removes files from a storage bucket; `failed` counts the ones that could not be removed. */
  removePhotos(bucket: "private" | "public", paths: string[]): Promise<{ failed: number }>;
}

export type PurgeResult = PurgeRaw & {
  /** Photo files in storage: removed with --apply, otherwise those that would be. */
  photos: { private: number; public: number };
};

const MISSING = "The sample-data function is missing. Run supabase/migrations/2026-10-20_privacy_and_hardening.sql in the Supabase SQL editor.";

export function describePurgeError(message: string): string {
  return /purge_sample_data|schema cache|could not find the function|42883/i.test(message) ? MISSING : message;
}

/** A story image that lives in the public article-images bucket: its file name, else null. Mirrors lib/erasure/erase.ts. */
const PUBLIC_IMAGE_PATH = "/storage/v1/object/public/article-images/";
export function publicPhotoOf(imageUrl: string | null): string | null {
  if (!imageUrl) return null;
  try {
    const path = new URL(imageUrl).pathname;
    return path.startsWith(PUBLIC_IMAGE_PATH) && path.length > PUBLIC_IMAGE_PATH.length ? decodeURIComponent(path.slice(PUBLIC_IMAGE_PATH.length)) : null;
  } catch {
    return null;
  }
}

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The database's answer as typed data, whatever shape it comes in. */
export function parsePurge(raw: unknown): PurgeRaw {
  const r = (raw ?? {}) as Record<string, unknown>;
  const d = (r.deleted ?? {}) as Record<string, unknown>;
  return {
    apply: r.apply === true,
    articles: arr<SampleArticle>(r.articles),
    submissions: num(r.submissions),
    raw_items: num(r.raw_items),
    sources: arr<SampleSource>(r.sources),
    photo_paths: arr<unknown>(r.photo_paths).filter((p): p is string => typeof p === "string" && p.length > 0),
    deleted: { articles: num(d.articles), raw_items: num(d.raw_items), sources: num(d.sources) },
  };
}

/** Lists what is sample data and, with `apply`, deletes it. Photo files go first: if one cannot be removed nothing is deleted. */
export async function runPurgeSample(opts: { apply?: boolean }, store: PurgeStore): Promise<PurgeResult> {
  const apply = opts.apply === true;
  try {
    const found = await store.purge(false); // always look first: a dry run changes nothing
    const publicPhotos = [...new Set(found.articles.map((a) => publicPhotoOf(a.image_url)).filter((p): p is string => Boolean(p)))];
    const photos = { private: found.photo_paths.length, public: publicPhotos.length };
    if (!apply) return { ...found, apply: false, photos };

    if (found.photo_paths.length > 0) {
      const r = await store.removePhotos("private", found.photo_paths);
      if (r.failed > 0) throw new Error(`${r.failed} private photos could not be removed from storage, so nothing was deleted. Check the storage settings and try again.`);
    }
    if (publicPhotos.length > 0) {
      const r = await store.removePhotos("public", publicPhotos);
      if (r.failed > 0) throw new Error(`${r.failed} public photos could not be removed from storage, so nothing was deleted. Check the storage settings and try again.`);
    }
    return { ...(await store.purge(true)), apply: true, photos };
  } catch (err) {
    throw new Error(describePurgeError(err instanceof Error ? err.message : String(err)));
  }
}

const STATUS_NAME: Record<string, string> = { pending_review: "pending review" };
const MAX_LISTED = 25;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A clear summary for the terminal: what is, or was, sample data. */
export function formatPurge(r: PurgeResult): string {
  const byStatus = new Map<string, number>();
  for (const a of r.articles) byStatus.set(a.status, (byStatus.get(a.status) ?? 0) + 1);
  const statuses = [...byStatus].map(([s, n]) => `${n} ${STATUS_NAME[s] ?? s}`).join(", ");
  const employee = r.articles.filter((a) => a.origin === "employee").length;
  const lines: string[] = [];

  lines.push(r.apply ? "Sample data DELETED." : "Sample data found (DRY RUN: nothing was deleted). Run again with --apply to delete it.");
  lines.push("");
  lines.push(`Articles: ${r.articles.length}${statuses ? ` (${statuses})` : ""}${employee ? `, ${plural(employee, "employee submission", "employee submissions")}` : ""}`);
  for (const a of r.articles.slice(0, MAX_LISTED)) lines.push(`  - [${STATUS_NAME[a.status] ?? a.status}${a.origin === "employee" ? ", employee" : ""}] ${a.headline.slice(0, 90)}`);
  if (r.articles.length > MAX_LISTED) lines.push(`  ... and ${r.articles.length - MAX_LISTED} more`);
  lines.push(`Test submissions: ${plural(r.submissions, "submitter record", "submitter records")} (deleted with their articles)`);
  lines.push(`Placeholder sources: ${r.sources.length}`);
  for (const s of r.sources.slice(0, MAX_LISTED)) lines.push(`  - ${s.name}  ${s.rss_url}`);
  if (r.sources.length > MAX_LISTED) lines.push(`  ... and ${r.sources.length - MAX_LISTED} more`);
  lines.push(`Raw items from example.com / placeholder sources: ${r.raw_items}`);
  lines.push(`Photos in storage: ${r.photos.private} private, ${r.photos.public} public`);
  lines.push("");
  if (r.apply) {
    lines.push(`Deleted: ${plural(r.deleted.articles, "article", "articles")}, ${plural(r.deleted.raw_items, "raw item", "raw items")}, ${plural(r.deleted.sources, "source", "sources")}, ${r.photos.private + r.photos.public} photo files.`);
    lines.push("Kept: departments, real sources, the AI spend log (its references to deleted rows are cleared), and every article that is not sample data.");
  } else {
    lines.push("Selection rules: an article whose headline starts with \"SAMPLE\" or whose slug starts with \"sample-\", whose source is on example.com/.org/.net, or that an employee");
    lines.push("submitted from a test address (example.com/.org/.net, localhost, *.test, *.invalid); raw items from example.com/.org/.net or from a placeholder source;");
    lines.push("sources whose feed is https://example.com/replace-me/... Nothing else is touched.");
  }
  return lines.join("\n");
}