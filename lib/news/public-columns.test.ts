import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => ({}) }));

import { PUBLIC_ARTICLE_COLUMNS, PUBLIC_FEED_COLUMNS } from "./queries";
import { INTERNAL_ARTICLE_COLUMNS, PUBLIC_ARTICLE_DISPLAY_COLUMNS, PUBLIC_ARTICLE_GRANTED_COLUMNS, PUBLIC_ARTICLE_LIST_COLUMNS } from "./public-columns";
import { containsEmail } from "@/lib/privacy";

// SEC-02: the database lets the public key read only some columns of articles. The query, the list in code and
// the GRANT in the SQL files must all say the same thing.

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
// The 2026-10-18 migration replaces the grant of 2026-10-17 (it adds `summary`), so it is the one kept in step with the code.
const SQL_FILES = ["supabase/migrations/2026-10-22_story_blocks.sql", "supabase/schema.sql"];
const SCRUB_FILES = ["supabase/migrations/2026-10-17_security_and_indexes.sql", "supabase/schema.sql"];

/** The column list of `grant select ( ... ) on public.articles`. */
function grantedInSql(text: string): string[] {
  const m = /grant select \(([^)]*)\) on public\.articles to anon, authenticated;/i.exec(text);
  expect(m, "grant statement not found").not.toBeNull();
  return m![1].split(",").map((c) => c.trim()).filter(Boolean);
}

describe("columns the public query selects", () => {
  const selected = PUBLIC_ARTICLE_COLUMNS.replace(/,?\s*departments\([^)]*\)/, "").split(",").map((c) => c.trim());

  it("are exactly the display columns, never *", () => {
    expect(selected).toEqual([...PUBLIC_ARTICLE_DISPLAY_COLUMNS]);
    expect(PUBLIC_ARTICLE_COLUMNS).not.toContain("*");
  });

  it("never include an internal column or anything that looks like an email", () => {
    for (const internal of INTERNAL_ARTICLE_COLUMNS) expect(selected).not.toContain(internal);
    expect(PUBLIC_ARTICLE_COLUMNS).not.toMatch(/email|ip_hash|image_path|submitter|fact_check|review_note|image_query|raw_item/i);
    expect(containsEmail(PUBLIC_ARTICLE_COLUMNS)).toBe(false);
  });

  it("are all granted to the public key, together with the columns the filters and the join use", () => {
    for (const c of selected) expect(PUBLIC_ARTICLE_GRANTED_COLUMNS).toContain(c);
    // .eq("status"), .order("published_at"), .eq("slug") and the departments join (department_id)
    for (const c of ["status", "published_at", "slug", "department_id"]) expect(PUBLIC_ARTICLE_GRANTED_COLUMNS).toContain(c);
  });

  it("keeps the internal columns apart from the granted ones", () => {
    for (const internal of INTERNAL_ARTICLE_COLUMNS) expect(PUBLIC_ARTICLE_GRANTED_COLUMNS).not.toContain(internal);
  });
});

describe("columns the feed list selects (PERF-01)", () => {
  const selected = PUBLIC_FEED_COLUMNS.replace(/,?\s*departments\([^)]*\)/, "").split(",").map((c) => c.trim());

  it("are the display columns without the body and the source date, and include the stored summary", () => {
    expect(selected).toEqual([...PUBLIC_ARTICLE_LIST_COLUMNS]);
    expect(selected).not.toContain("body");
    expect(selected).not.toContain("source_published_at");
    expect(selected).toContain("summary");
    // what a card, the globe and the byline need
    for (const c of ["slug", "headline", "place", "country_code", "lat", "lon", "published_at", "image_url", "image_alt", "origin", "author_first_name"]) {
      expect(selected).toContain(c);
    }
  });

  it("are all granted to the public key and never include an internal column", () => {
    for (const c of selected) expect(PUBLIC_ARTICLE_GRANTED_COLUMNS).toContain(c);
    for (const internal of INTERNAL_ARTICLE_COLUMNS) expect(selected).not.toContain(internal);
  });
});

describe("the older grants", () => {
  it("are subsets of the current list, so running them in order ends in the right state", () => {
    for (const file of ["2026-10-17_security_and_indexes.sql", "2026-10-18_article_summary.sql"]) {
      for (const c of grantedInSql(read(`supabase/migrations/${file}`))) expect(PUBLIC_ARTICLE_GRANTED_COLUMNS, file).toContain(c);
    }
  });

  it("2026-10-22_story_blocks.sql adds exactly the two Write columns to the 2026-10-18 list", () => {
    const before = new Set(grantedInSql(read("supabase/migrations/2026-10-18_article_summary.sql")));
    expect(grantedInSql(read("supabase/migrations/2026-10-22_story_blocks.sql")).filter((c) => !before.has(c)).sort()).toEqual(["body_blocks", "body_format"]);
  });

  it("tells whoever re-runs it to run 2026-10-18 after it", () => {
    expect(read("supabase/migrations/2026-10-17_security_and_indexes.sql")).toMatch(/run 2026-10-18_article_summary\.sql after it/);
  });
});

describe.each(["supabase/migrations/2026-10-18_article_summary.sql", "supabase/schema.sql"])("%s (summary)", (file) => {
  const text = read(file);

  it("has the summary column and backfills only the rows that have none", () => {
    expect(text).toMatch(/add column if not exists summary text/i);
    expect(text).toMatch(/update public\.articles a\s+set summary = s\.v/);
    expect(text).toMatch(/where summary is null or summary = '/);
    expect(text).toContain("left(n, 240)");
  });
});

describe.each(SQL_FILES)("%s", (file) => {
  const text = read(file);

  it("grants the public key exactly the columns listed in code", () => {
    expect([...grantedInSql(text)].sort()).toEqual([...PUBLIC_ARTICLE_GRANTED_COLUMNS].sort());
  });

  it("revokes the table-wide SELECT first, so select * fails for the public key", () => {
    const revoke = text.indexOf("revoke select on public.articles from anon, authenticated;");
    const grant = text.indexOf("grant select (");
    expect(revoke).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(revoke);
  });

  it("never grants an internal column", () => {
    const granted = grantedInSql(text);
    for (const internal of INTERNAL_ARTICLE_COLUMNS) expect(granted).not.toContain(internal);
  });

});

describe.each(SCRUB_FILES)("%s", (file) => {
  const text = read(file);

  it("scrubs email addresses from review_note and fact_check_notes with 'an editor'", () => {
    expect(text).toMatch(/update public\.articles\s+set review_note = regexp_replace\(review_note, '[^']*(''[^']*)*', 'an editor', 'g'\)\s+where review_note ~ '@';/);
    expect(text).toMatch(/update public\.articles\s+set fact_check_notes = regexp_replace\(fact_check_notes, '[^']*(''[^']*)*', 'an editor', 'g'\)\s+where fact_check_notes ~ '@';/);
  });
});
