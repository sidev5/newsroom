import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

// What the public site can see. The author's email, the IP hash and the photo path live in
// article_submitters; these tests make sure no public query, and no public file, can reach them.

const mocks = vi.hoisted(() => ({
  columns: [] as string[],
  ranges: [] as [number, number][],
  result: [] as { data: unknown; error: unknown }[],
}));

// unstable_cache needs the Next runtime; here it just calls the function.
vi.mock("next/cache", () => ({ unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn }));
vi.mock("@/lib/supabase/public", () => ({
  supabasePublic: () => ({
    from: () => ({
      select: (columns: string) => {
        mocks.columns.push(columns);
        const next = () => Promise.resolve(mocks.result.shift() ?? { data: [], error: null });
        const b: Record<string, unknown> = {};
        for (const m of ["eq", "order"]) b[m] = () => b;
        b.range = (from: number, to: number) => {
          mocks.ranges.push([from, to]);
          return next();
        };
        b.maybeSingle = next;
        return b;
      },
    }),
  }),
}));

import { getFeedPage, getStoryBySlug, PUBLIC_ARTICLE_COLUMNS, PUBLIC_FEED_COLUMNS, toFeedStory, toStory } from "./queries";
import { allowedImageUrl } from "./format";
import { byline, EMPLOYEE_TAG, originTag } from "./byline";
import type { Story } from "./types";

const EMAIL = "ada.lovelace@adorpower.com";

/** A database row as it would look if the table (or a join) wrongly carried private data. */
const leakyRow = (over: Record<string, unknown> = {}) => ({
  id: "a1",
  slug: "pilot-line-abcdef12",
  headline: "Pilot line finished",
  body: "Body text.",
  summary: "Body text.",
  place: "India",
  lat: null,
  lon: null,
  country_code: "IN",
  country_name: "India",
  source_urls: [],
  source_published_at: null,
  published_at: "2026-10-15T09:00:00.000Z",
  image_url: "https://abc.supabase.co/storage/v1/object/public/article-images/x.webp",
  image_credit: "Photo by Ada",
  image_credit_url: null,
  image_alt: null,
  origin: "employee",
  author_first_name: "Ada",
  author_last_name: "Lovelace",
  author_department: "Software Development",
  departments: { name: "AI & Technology", slug: "ai-technology", kind: "company" },
  // none of these may ever reach the browser:
  email: EMAIL,
  ip_hash: "9f2c".repeat(16),
  image_path: "secret-private-path.webp",
  email_verified: true,
  article_submitters: { email: EMAIL, ip_hash: "abc" },
  fact_check_notes: "- internal note",
  review_note: "internal",
  department_id: "d-ai",
  status: "published",
  ...over,
});

const STORY_KEYS = [
  "id", "slug", "headline", "body", "summary", "department", "place", "lat", "lon", "country_code", "country_name", "source_urls",
  "source_published_at", "published_at", "image_url", "image_credit", "image_credit_url", "image_alt", "origin",
  "author_first_name", "author_last_name", "author_department", "body_format", "body_blocks",
].sort();
/** The feed list has no body and no source date. */
const FEED_KEYS = STORY_KEYS.filter((k) => k !== "body" && k !== "source_published_at" && k !== "body_format" && k !== "body_blocks");

beforeEach(() => {
  mocks.columns.length = 0;
  mocks.ranges.length = 0;
  mocks.result.length = 0;
});

describe("the public stories never carry an email", () => {
  it("toStory copies exactly the Story fields, so extra columns in a row cannot leak", () => {
    const story = toStory(leakyRow() as never);
    expect(Object.keys(story).sort()).toEqual(STORY_KEYS);
    const json = JSON.stringify(story);
    expect(json).not.toContain(EMAIL);
    expect(json).not.toContain("@");
    for (const secret of ["email", "ip_hash", "image_path", "article_submitters", "fact_check_notes", "review_note", "department_id", "secret-private-path"]) {
      expect(json).not.toContain(secret);
    }
  });

  it("toFeedStory copies exactly the feed fields: no body, no source date, no extra columns", () => {
    const story = toFeedStory(leakyRow() as never);
    expect(Object.keys(story).sort()).toEqual(FEED_KEYS);
    expect(story).not.toHaveProperty("body");
    expect(JSON.stringify(story)).not.toContain("@");
  });

  it("the list and single-story queries return no email even when the rows contain one", async () => {
    mocks.result.push({ data: [leakyRow(), leakyRow({ id: "a2", slug: "b" })], error: null });
    const { stories } = await getFeedPage();
    expect(JSON.stringify(stories)).not.toContain("@");
    expect(Object.keys(stories[0]).sort()).toEqual(FEED_KEYS);

    mocks.result.push({ data: leakyRow(), error: null });
    const one = await getStoryBySlug("pilot-line-abcdef12");
    expect(JSON.stringify(one)).not.toContain("@");
    expect(Object.keys(one!).sort()).toEqual(STORY_KEYS);
  });

  it("selects explicit columns: never *, never the submitters table", async () => {
    mocks.result.push({ data: [], error: null }, { data: null, error: null });
    await getFeedPage();
    await getStoryBySlug("x");
    expect(mocks.columns).toEqual([PUBLIC_FEED_COLUMNS, PUBLIC_ARTICLE_COLUMNS]);
    for (const c of mocks.columns) {
      expect(c).not.toContain("*");
      expect(c).not.toMatch(/email|ip_hash|image_path|submitter|fact_check|review_note/i);
    }
    expect(PUBLIC_ARTICLE_COLUMNS).toContain("author_first_name"); // the byline is public; the address is not
  });

  it("the feed list does not select the body; the single story does", () => {
    expect(PUBLIC_FEED_COLUMNS.split(",").map((c) => c.trim())).not.toContain("body");
    expect(PUBLIC_FEED_COLUMNS).toContain("summary");
    expect(PUBLIC_ARTICLE_COLUMNS).toContain("body");
  });

  it("falls back to the old column list (every story AI) until the migration has been run", async () => {
    mocks.result.push(
      { data: null, error: { code: "42703", message: "column articles.summary does not exist" } },
      { data: null, error: { code: "42703", message: "column articles.origin does not exist" } },
      { data: [leakyRow({ origin: undefined, author_first_name: undefined, summary: undefined })], error: null },
    );
    const { stories } = await getFeedPage();
    expect(mocks.columns).toHaveLength(3);
    // without `summary` the feed selects the body, and the summary is cut from it in code
    expect(mocks.columns[1]).toContain("body");
    expect(mocks.columns[1]).not.toMatch(/\bsummary\b/);
    expect(mocks.columns[2]).not.toContain("origin");
    expect(mocks.columns[2]).not.toContain("author_");
    expect(stories[0]).toMatchObject({ origin: "ai", author_first_name: null, summary: "Body text." });
    expect(stories[0]).not.toHaveProperty("body");
  });

  it("falls back for the single story too: first without the Write columns, then without the summary", async () => {
    mocks.result.push(
      { data: null, error: { code: "42703", message: "column articles.body_blocks does not exist" } },
      { data: null, error: { code: "42703", message: "column articles.summary does not exist" } },
      { data: leakyRow({ summary: undefined }), error: null },
    );
    const one = await getStoryBySlug("pilot-line-abcdef12");
    expect(mocks.columns).toHaveLength(3);
    expect(mocks.columns[0]).toContain("body_blocks");
    expect(mocks.columns[1]).not.toMatch(/body_blocks|body_format/);
    expect(mocks.columns[1]).toMatch(/\bsummary\b/);
    expect(mocks.columns[2]).not.toMatch(/\bsummary\b/);
    expect(one).toMatchObject({ body: "Body text.", summary: "Body text.", body_format: "plain", body_blocks: null });
  });
  it("still reports other database errors", async () => {
    mocks.result.push({ data: null, error: { code: "XX000", message: "boom" } });
    await expect(getFeedPage()).rejects.toThrow("boom");
    expect(mocks.columns).toHaveLength(1); // no fallback for an error that is not a missing column
  });

  it("does not show an author on an AI story, even if the columns hold values", () => {
    const story = toStory(leakyRow({ origin: "ai" }) as never);
    expect(story).toMatchObject({ origin: "ai", author_first_name: null, author_last_name: null, author_department: null });
  });
});

describe("the feed is paged (PERF-01)", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => leakyRow({ id: `a${i}`, slug: `s${i}` }));

  it("asks for 60 stories by default and one more row to learn whether there are older ones", async () => {
    mocks.result.push({ data: rows(61), error: null });
    const page = await getFeedPage();
    expect(mocks.ranges).toEqual([[0, 60]]);
    expect(page.stories).toHaveLength(60);
    expect(page.hasMore).toBe(true);
  });

  it("hasMore is false when the page is not full", async () => {
    mocks.result.push({ data: rows(60), error: null });
    const page = await getFeedPage();
    expect(page.stories).toHaveLength(60);
    expect(page.hasMore).toBe(false);
  });

  it("continues from an offset, and clamps a silly limit or offset", async () => {
    mocks.result.push({ data: rows(5), error: null }, { data: [], error: null }, { data: [], error: null });
    await getFeedPage(60, 60);
    await getFeedPage(-5, 100_000);
    await getFeedPage(Number.NaN, 0);
    // (offset, offset + limit): the extra row is the look-ahead. A limit of 0 or NaN falls back to the default 60.
    expect(mocks.ranges).toEqual([
      [60, 120],
      [0, 100],
      [0, 60],
    ]);
  });
});
describe("byline and tag", () => {
  const employee = { origin: "employee" as const, author_first_name: "Ada", author_last_name: "Lovelace", author_department: "Software Development" };
  const aiStory = { origin: "ai" as const, author_first_name: null, author_last_name: null, author_department: null };

  it("says 'By <First> <Last> · <Department>' for an employee story and nothing for an AI story", () => {
    expect(byline(employee)).toBe("By Ada Lovelace · Software Development");
    expect(byline({ ...employee, author_department: null })).toBe("By Ada Lovelace");
    expect(byline({ ...employee, author_first_name: null, author_last_name: null })).toBeNull();
    expect(byline(aiStory)).toBeNull();
  });

  it("uses 'Employee contribution' in place of 'AI-generated'", () => {
    expect(originTag(employee)).toBe(EMPLOYEE_TAG);
    expect(EMPLOYEE_TAG).toBe("Employee contribution");
    expect(originTag(aiStory)).toBe("AI-generated");
  });
});

describe("photos of published employee stories", () => {
  const prev = process.env.NEXT_PUBLIC_SUPABASE_URL;
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc.supabase.co";
  });
  it("only the public bucket of this project is shown, besides Unsplash", () => {
    expect(allowedImageUrl("https://abc.supabase.co/storage/v1/object/public/article-images/x.webp")).not.toBeNull();
    expect(allowedImageUrl("https://images.unsplash.com/photo-1")).not.toBeNull();
    // the private bucket, other buckets, other projects and insecure URLs are not
    expect(allowedImageUrl("https://abc.supabase.co/storage/v1/object/sign/submission-images/x.webp?token=t")).toBeNull();
    expect(allowedImageUrl("https://abc.supabase.co/storage/v1/object/public/submission-images/x.webp")).toBeNull();
    expect(allowedImageUrl("https://evil.supabase.co/storage/v1/object/public/article-images/x.webp")).toBeNull();
    expect(allowedImageUrl("http://abc.supabase.co/storage/v1/object/public/article-images/x.webp")).toBeNull();
    expect(allowedImageUrl("/images/defaults/ev.svg")).toBeNull();
    process.env.NEXT_PUBLIC_SUPABASE_URL = prev;
  });
});

// ---------------------------------------------------------------------------
// Boundaries in the source tree: the public pages cannot reach the service role or the submitters table
// ---------------------------------------------------------------------------
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Code only: comments may talk about private tables without touching them. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function sources(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name) || /\.test\.ts$/.test(entry.name)) continue;
    const full = join(entry.parentPath, entry.name);
    out.push({ path: relative(ROOT, full).split(sep).join("/"), text: stripComments(readFileSync(full, "utf8")) });
  }
  return out;
}

const all = ["app", "components", "lib", "scripts"].flatMap(sources);
const importing = (needle: string) => all.filter((f) => f.text.includes(`"${needle}`)).map((f) => f.path);
const isPublicFile = (p: string) =>
  p.startsWith("components/") ||
  p.startsWith("lib/news/") ||
  p === "app/page.tsx" ||
  p.startsWith("app/article/") ||
  p === "app/submit/page.tsx" ||
  p === "app/submit/SubmitForm.tsx" ||
  p.startsWith("app/submit/thanks/");

describe("source boundaries", () => {
  it("public files never import the service-role client or the submission admin/store modules", () => {
    const forbidden = ["@/lib/supabase/admin", "@/lib/submissions/admin", "@/lib/submissions/store", "@/lib/submissions/runtime"];
    for (const mod of forbidden) {
      expect(importing(mod).filter(isPublicFile), mod).toEqual([]);
    }
  });

  it("only the review code reads submitter details (email, flags, photo links)", () => {
    expect(importing("@/lib/submissions/admin").sort()).toEqual(["app/admin/(protected)/review/page.tsx", "lib/admin/review.ts"]);
    // lib/submissions/runtime.ts is the only file that builds the service-role store
    expect(all.filter((f) => /from "\.\/store"/.test(f.text) && f.path.startsWith("lib/submissions/")).map((f) => f.path)).toEqual(["lib/submissions/runtime.ts"]);
    expect(importing("@/lib/submissions/store")).toEqual([]);
    expect(importing("@/lib/submissions/runtime")).toEqual(["app/api/write/submit/route.ts"]);
  });

  it("every query made with the public (anon) client selects explicit columns and never the submitters table", () => {
    const publicQueries = all.filter(
      (f) => (f.text.includes('"@/lib/supabase/server"') || f.text.includes('"@/lib/supabase/public"')) && !f.path.startsWith("lib/admin/"),
    );
    expect(publicQueries.map((f) => f.path)).toEqual(expect.arrayContaining(["lib/news/queries.ts", "app/submit/page.tsx"]));
    for (const f of publicQueries) {
      expect(f.text, f.path).not.toMatch(/article_submitters/);
      expect(f.text, f.path).not.toMatch(/\.select\(\s*["'`]\*["'`]/);
      expect(f.text, f.path).not.toMatch(/\.select\(\s*\)/);
    }
  });

  it("the cached public pages read no cookies or headers, so revalidate = 60 can take effect (PERF-05)", () => {
    const find = (p: string) => all.find((f) => f.path === p)!;
    // the homepage and article queries use the cookie-free client; the cookie-bound one would make every page dynamic
    expect(find("lib/news/queries.ts").text).toContain('"@/lib/supabase/public"');
    expect(find("lib/news/queries.ts").text).not.toContain("@/lib/supabase/server");
    expect(find("lib/supabase/public.ts").text).not.toMatch(/next\/headers|cookies\(|headers\(/);
    for (const page of ["app/page.tsx", "app/article/[slug]/page.tsx"]) {
      const text = find(page).text;
      expect(text, page).toMatch(/export const revalidate = 60;/);
      expect(text, page).not.toMatch(/force-dynamic|next\/headers|cookies\(|headers\(/);
    }
  });

  it("the story API routes are public, validate their input and are never cached by the browser", () => {
    const stories = all.find((f) => f.path === "app/api/stories/route.ts")!.text;
    const story = all.find((f) => f.path === "app/api/story/[slug]/route.ts")!.text;
    for (const text of [stories, story]) {
      expect(text).toContain("no-store");
      expect(text).not.toMatch(/supabase\/admin|submissions\//);
    }
    // a fixed page size and offsets in multiples of it: a bounded number of cache entries and queries
    expect(stories).toMatch(/offset % FEED_PAGE_SIZE !== 0/);
    expect(stories).not.toMatch(/searchParams\.get\("limit"\)/);
    expect(story).toMatch(/SLUG\.test\(slug\)/);
  });
  it("the public pages and components never mention the submitter's email column", () => {
    for (const f of all.filter((x) => isPublicFile(x.path) && !x.path.endsWith("SubmitForm.tsx") && x.path !== "app/submit/page.tsx")) {
      expect(f.text, f.path).not.toMatch(/ip_hash|image_path|article_submitters|SubmitterView/);
    }
  });
});

describe("database policies in the SQL files", () => {
  const sql = ["supabase/migrations/2026-10-15-ai-tech-and-submissions.sql", "supabase/schema.sql"].map((p) => ({ p, text: readFileSync(join(ROOT, p), "utf8") }));

  it.each(sql)("$p: article_submitters has RLS on, no policy and no public privileges", ({ text }) => {
    expect(text).toMatch(/alter table public\.article_submitters enable row level security/i);
    expect(text).toMatch(/revoke all on public\.article_submitters from anon, authenticated/i);
    expect(text).not.toMatch(/create policy[^;]*on public\.article_submitters/i);
  });

  it.each(sql)("$p: nothing lets the public insert or update, and the submission bucket is private", ({ text }) => {
    expect(text).not.toMatch(/create policy[^;]*for (insert|update|delete|all)[^;]*to[^;]*anon/i);
    expect(text).toMatch(/values \('submission-images', 'submission-images', false/);
    expect(text).toMatch(/values \('article-images', 'article-images', true/);
    // the only storage policy is a read of the public bucket
    const policies = [...text.matchAll(/create policy[^;]*on storage\.objects[^;]*;/gi)].map((m) => m[0]);
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatch(/for select/i);
    expect(policies[0]).toMatch(/bucket_id = 'article-images'/);
  });

  it.each(sql)("$p: ends the AI & Technology section by reloading the API schema", ({ text }) => {
    expect(text.trimEnd().endsWith("notify pgrst, 'reload schema';")).toBe(true);
  });
});

describe("Story type", () => {
  it("has the byline fields but no email", () => {
    const keys: (keyof Story)[] = ["author_first_name", "author_last_name", "author_department", "origin"];
    expect(keys).toHaveLength(4);
    // a compile-time check too: this line would not type-check if Story had an email field assigned here
    const probe: Story extends { email: string } ? never : true = true;
    expect(probe).toBe(true);
  });
});
