import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The code writes rows to review_log; the database has a CHECK on `action` and only the columns its migrations created. If the code
// starts writing a new action or column and the schema is not changed with it, audit-log writes fail in production (and, because they
// are best effort, only as a warning). This test compares what the code writes with what schema.sql and the migrations define.

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const schema = read("supabase/schema.sql");
const migrations = readdirSync(new URL("../../supabase/migrations/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort();

/** Files that insert into review_log. A new one must be added here, and its actions and columns are then checked too. */
const WRITERS = ["lib/admin/review.ts", "lib/admin/recover.ts"];

const reviewTs = read("lib/admin/review.ts");
const entryType = /export type ReviewLogEntry = \{([\s\S]*?)\n\};/.exec(reviewTs)![1];
const codeColumns = [...entryType.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]).sort();
const typeActions = [...(/export type ReviewAction = ([^;]+);/.exec(reviewTs)![1].matchAll(/"(\w+)"/g))].map((m) => m[1]);
const literalActions = WRITERS.flatMap((f) => [...read(f).matchAll(/\baction: "(\w+)"/g)].map((m) => m[1]));
const codeActions = [...new Set([...typeActions, ...literalActions.filter((a) => a !== "edit")])].sort();

/** The values of the last `review_log_action_check` defined in a SQL text. */
function constraintActions(sql: string): string[] | null {
  const defs = [...sql.matchAll(/review_log_action_check\s+check \(action in \(([^)]*)\)\)/g)];
  const last = defs.at(-1);
  return last ? [...last[1].matchAll(/'(\w+)'/g)].map((m) => m[1]).sort() : null;
}

/** The final constraint after running every migration in file order. */
const migratedActions = migrations.reduce<string[] | null>((acc, f) => constraintActions(read(`supabase/migrations/${f}`)) ?? acc, null);
// The inline check of the original create table, used when no later statement replaced it.
const original = [...(/create table if not exists public\.review_log \(([\s\S]*?)\n\);/.exec(read("supabase/migrations/2026-10-14_world_review_pipeline.sql"))![1].matchAll(/'(\w+)'/g))].map((m) => m[1]);

function columnsDefinedBy(sql: string): Set<string> {
  const cols = new Set<string>();
  const table = /create table if not exists public\.review_log \(([\s\S]*?)\n\);/.exec(sql);
  for (const m of table?.[1].matchAll(/^\s{2}(\w+)\s+\w+/gm) ?? []) cols.add(m[1]);
  for (const m of sql.matchAll(/alter table public\.review_log add column if not exists (\w+)/g)) cols.add(m[1]);
  return cols;
}

describe("review_log: what the code writes is what the database accepts", () => {
  it("finds the actions and columns in the code (guards the parsing above)", () => {
    expect(codeActions).toEqual(expect.arrayContaining(["approve", "reject", "unpublish", "restore", "mark_relevant"]));
    expect(codeColumns).toEqual(expect.arrayContaining(["article_id", "action", "actor_email", "reason", "bulk", "created_at", "raw_item_id", "previous_status"]));
  });

  it("every action the code writes is in the CHECK constraint of schema.sql", () => {
    const allowed = constraintActions(schema);
    expect(allowed, "schema.sql has no review_log_action_check").not.toBeNull();
    expect(codeActions.filter((a) => !allowed!.includes(a)), "actions the code writes but schema.sql rejects").toEqual([]);
  });

  it("every action the code writes is accepted once all migrations have run", () => {
    expect(migratedActions).not.toBeNull();
    expect(codeActions.filter((a) => !migratedActions!.includes(a)), "actions the code writes but the migrations reject").toEqual([]);
    expect(migratedActions).not.toEqual(original); // the original constraint alone is not enough
  });

  it("the constraint allows exactly the actions the code can write, no stale ones", () => {
    expect(constraintActions(schema)).toEqual(codeActions);
    expect(migratedActions).toEqual(codeActions);
  });

  it("every column the code writes exists in schema.sql and in the migrations", () => {
    const inSchema = columnsDefinedBy(schema);
    const inMigrations = new Set(migrations.flatMap((f) => [...columnsDefinedBy(read(`supabase/migrations/${f}`))]));
    expect(codeColumns.filter((c) => !inSchema.has(c)), "columns missing from schema.sql").toEqual([]);
    expect(codeColumns.filter((c) => !inMigrations.has(c)), "columns missing from the migrations").toEqual([]);
  });

  it("the repair migration alone brings an old table up to date (columns, constraint, schema reload)", () => {
    const repair = read("supabase/migrations/2026-10-22_review_log_repair.sql");
    expect(columnsDefinedBy(repair)).toEqual(new Set(["raw_item_id", "previous_status"]));
    expect(constraintActions(repair)).toEqual(codeActions);
    expect(repair).toMatch(/drop constraint if exists review_log_action_check/);
    expect(repair).toMatch(/raw_item_id uuid references public\.raw_items\(id\) on delete set null/);
    expect(repair.trimEnd().endsWith("notify pgrst, 'reload schema';")).toBe(true);
    expect(repair).not.toMatch(/\bcreate table\b|\bdrop table\b|\bdelete from\b|\btruncate\b/i);
  });

  it("only the known files insert into review_log", () => {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(new URL(`../../${dir}/`, import.meta.url), { withFileTypes: true })) {
        const path = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && /from\("review_log"\)\s*\.insert|\.from\("review_log"\)[\s\S]{0,40}\.insert/.test(read(path))) found.push(path);
      }
    };
    for (const dir of ["lib", "app", "scripts"]) walk(dir);
    expect(found.sort(), "a new insert into review_log: add the file to WRITERS so its actions and columns are checked").toEqual([...WRITERS].sort());
  });
});
