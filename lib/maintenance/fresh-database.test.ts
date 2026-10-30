import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A new, empty Supabase project is built with supabase/schema.sql, then supabase/seed.sql (README, "The database"). These checks
// catch the two ways that broke without anyone noticing on the existing database: a statement that names a column before the
// file creates it, and a seed statement swallowed by a comment.
const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const SQL_FILES = ["supabase/schema.sql", "supabase/seed.sql", "supabase/delete_sample_data.sql"];

/** The statements of a file with comments removed, keeping their character offsets. */
const uncommented = (sql: string) => sql.replace(/--[^\n]*/g, (c) => " ".repeat(c.length));

describe("supabase/schema.sql on an empty database", () => {
  const sql = uncommented(read("supabase/schema.sql"));

  it("creates every column of the public articles grant before the grant", () => {
    const grant = /grant select \(([^)]*)\) on public\.articles to anon, authenticated;/i.exec(sql);
    expect(grant, "schema.sql has no column grant on articles").not.toBeNull();
    const before = sql.slice(0, grant!.index);
    const createTable = /create table if not exists public\.articles \(([\s\S]*?)\n\);/i.exec(before)?.[1] ?? "";
    const columns = grant![1].split(",").map((c) => c.trim()).filter(Boolean);
    const missing = columns.filter(
      (c) => !new RegExp(`^\\s*${c}\\s`, "m").test(createTable) && !new RegExp(`alter table public\\.articles add column if not exists ${c}\\b`, "i").test(before),
    );
    expect(missing, "columns granted before schema.sql creates them").toEqual([]);
  });
});

describe("supabase/seed.sql", () => {
  const sql = uncommented(read("supabase/seed.sql"));

  it("inserts the departments and both groups of sources (placeholders and world feeds) as real statements", () => {
    expect(sql.match(/insert into public\.departments/gi)).toHaveLength(1);
    expect(sql.match(/insert into public\.sources/gi)).toHaveLength(2);
  });

  it("starts every select of an insert ... select on the line after its insert", () => {
    for (const m of sql.matchAll(/^\s*select s\.name/gim)) {
      const previous = sql.slice(0, m.index).trimEnd().split("\n").at(-1) ?? "";
      expect(previous).toMatch(/^insert into public\.sources/i);
    }
  });
});

describe("SQL files", () => {
  it.each(SQL_FILES)("%s has no leftover placeholder for a line break", (file) => {
    expect(read(file)).not.toContain("$nl");
  });
});
