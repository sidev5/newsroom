import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { READER_LIMITS, STORY_LIMITS } from "@/lib/config";
import { INTERNAL_ARTICLE_COLUMNS, PUBLIC_ARTICLE_DISPLAY_COLUMNS, PUBLIC_ARTICLE_LIST_COLUMNS } from "@/lib/news/public-columns";

// Row-level security and shape of the Write tables, read from the SQL files (as the other schema tests do): the migration is what
// the owner runs, schema.sql is what a fresh database is built from, and both must say the same.

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const FILES = [["the migration", read("supabase/migrations/2026-10-22_story_blocks.sql")], ["schema.sql", read("supabase/schema.sql")]] as const;
const migration = FILES[0][1];
const TABLES = ["article_likes", "article_comments", "reader_login_codes", "reader_events", "comment_log"];

describe.each(FILES)("%s", (_name, sql) => {
  it.each(TABLES)("%s: row-level security is on and the public roles have no table privileges", (table) => {
    expect(sql).toMatch(new RegExp(`alter table public\\.${table}\\s+enable row level security;`));
    expect(sql).toMatch(new RegExp(`revoke all on public\\.${table}\\s+from anon, authenticated;`));
  });

  it("only comments have a policy, and it shows visible comments of published articles only", () => {
    const policies = [...sql.matchAll(/create policy "([^"]+)"\s+on public\.(\w+)/g)].map((m) => `${m[2]}: ${m[1]}`);
    const mine = policies.filter((p) => TABLES.some((t) => p.startsWith(`${t}:`)));
    expect(mine).toEqual(["article_comments: public reads visible comments"]);
    expect(sql).toMatch(/using \(status = 'visible' and exists \(select 1 from public\.articles a where a\.id = article_id and a\.status = 'published'\)\)/);
  });

  it("the public key may read the comment columns except user_key", () => {
    const grant = /grant select \(([^)]*)\) on public\.article_comments to anon, authenticated;/.exec(sql);
    expect(grant).not.toBeNull();
    const columns = grant![1].split(",").map((c) => c.trim());
    expect(columns.sort()).toEqual(["article_id", "body", "created_at", "display_name", "id", "status"]);
    expect(columns).not.toContain("user_key");
  });

  it("like counts come from a view that shows counts of published articles and no user key", () => {
    const view = /create or replace view public\.article_like_counts as\n([\s\S]*?);/.exec(sql)![1];
    expect(view).toMatch(/select l\.article_id, count\(\*\)::int as likes/);
    expect(view).toContain("a.status = 'published'");
    expect(view).not.toContain("user_key");
    expect(sql).toContain("revoke all on public.article_like_counts from public, anon, authenticated;");
    expect(sql).toContain("grant select on public.article_like_counts to anon, authenticated;");
  });

  it("a person likes a story once (primary key), and comments are 1 to 1000 characters with two statuses", () => {
    expect(sql).toMatch(/create table if not exists public\.article_likes \([\s\S]*?primary key \(article_id, user_key\)/);
    expect(sql).toContain(`char_length(body) between 1 and ${READER_LIMITS.COMMENT_MAX}`);
    expect(sql).toContain("check (status in ('visible', 'hidden'))");
    expect(sql).toContain("check (action in ('hide', 'unhide'))");
  });

  it("the code-attempt function is for the service role only", () => {
    expect(sql).toContain("create or replace function public.reader_code_attempt(p_id uuid, p_max int) returns int");
    expect(sql).toContain("revoke all on function public.reader_code_attempt(uuid, int) from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function public.reader_code_attempt(uuid, int) to service_role;");
    expect(sql).toMatch(/where id = p_id and attempts < p_max and used_at is null\s+returning attempts;/);
  });

  it("the articles constraints: body_format is plain or blocks, and a blocks story has its JSON, within the size limit", () => {
    expect(sql).toContain("check (body_format in ('plain', 'blocks'))");
    expect(sql).toMatch(/check \(body_format <> 'blocks' or \(body_blocks is not null and jsonb_typeof\(body_blocks\) = 'object' and octet_length\(body_blocks::text\) <= 400000\)\)/);
    expect(STORY_LIMITS.PAYLOAD_MAX_BYTES).toBe(400_000);
    expect(sql).toContain("add column if not exists body_format text not null default 'plain'");
  });

  it("the retention function also clears the real name, the department and the block images when it anonymizes", () => {
    // the LAST definition in the file is the one a fresh database ends up with
    const last = (name: string) => [...sql.matchAll(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, "g"))].at(-1)![0];
    const fn = last("run_privacy_retention");
    for (const part of ["image_paths = '{}'", "first_name = null", "last_name = null", "author_department = null", "unnest(s.image_paths)"]) expect(fn).toContain(part);
    const purge = last("purge_sample_data");
    expect(purge).toContain("unnest(s.image_paths)");
  });
});

describe("the migration", () => {
  it("is idempotent: every statement can be run again", () => {
    expect(migration).not.toMatch(/\bdrop table\b|\btruncate\b/i); // (delete from appears only inside purge_sample_data)
    for (const m of migration.matchAll(/^create table (?!if not exists)/gim)) throw new Error(`create table without if not exists: ${m[0]}`);
    for (const m of migration.matchAll(/^create index (?!if not exists)/gim)) throw new Error(`create index without if not exists: ${m[0]}`);
    for (const m of migration.matchAll(/^alter table [\w.]+\s+add column (?!if not exists)/gim)) throw new Error(`add column without if not exists: ${m[0]}`);
    for (const m of migration.matchAll(/^create (function|view)\b(?! or replace)/gim)) throw new Error(`${m[0]} without or replace`);
    for (const m of migration.matchAll(/^alter table [\w.]+\s+drop constraint (?!if exists)/gim)) throw new Error(`drop constraint without if exists: ${m[0]}`);
    // a policy is dropped before it is created
    expect(migration).toMatch(/drop policy if exists "public reads visible comments" on public\.article_comments;\s+create policy "public reads visible comments"/);
  });

  it("ends by telling the API to reload its schema", () => {
    expect(migration.trimEnd().endsWith("notify pgrst, 'reload schema';")).toBe(true);
  });

  it("grants the public key the display columns of articles, including the two new ones, and never an internal one", () => {
    const grant = /grant select \(([^)]*)\) on public\.articles to anon, authenticated;/.exec(migration)![1].split(",").map((c) => c.trim());
    for (const c of PUBLIC_ARTICLE_DISPLAY_COLUMNS) expect(grant).toContain(c);
    for (const c of INTERNAL_ARTICLE_COLUMNS) expect(grant).not.toContain(c);
    expect(PUBLIC_ARTICLE_DISPLAY_COLUMNS).toEqual(expect.arrayContaining(["body_blocks", "body_format"]));
    // the feed list stays light: no blocks in the card list
    expect(PUBLIC_ARTICLE_LIST_COLUMNS).not.toContain("body_blocks");
    expect(PUBLIC_ARTICLE_LIST_COLUMNS).not.toContain("body_format");
  });

  it("says the same in schema.sql: every create table of the migration is there word for word", () => {
    const schema = FILES[1][1];
    for (const m of migration.matchAll(/create table if not exists public\.\w+ \([\s\S]*?\n\);/g)) expect(schema, m[0].split("\n")[0]).toContain(m[0]);
    for (const m of migration.matchAll(/alter table public\.\w+ add column if not exists [^\n]*/g)) expect(schema, m[0]).toContain(m[0]);
    for (const m of migration.matchAll(/create or replace function public\.(?:reader_code_attempt|run_privacy_retention|purge_sample_data)[\s\S]*?\n\$\$;/g)) expect(schema, m[0].split("\n")[0]).toContain(m[0]);
  });
});