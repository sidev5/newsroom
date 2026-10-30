import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { backupStatus, DEFAULT_MAX_AGE_DAYS, DUMP_FILE, formatBackupStatus, REMINDERS } from "./backup-check";

// DB-04: `npm run backup:check` and docs/BACKUP.md.

const DAY = 86_400_000;
const NOW = new Date("2026-10-20T10:00:00Z").getTime();
const file = (name: string, daysOld: number) => ({ name, mtimeMs: NOW - daysOld * DAY });

describe("backupStatus", () => {
  it("is 'none' with no files, or with files that are not dumps", () => {
    expect(backupStatus([], NOW)).toEqual({ state: "none" });
    expect(backupStatus([file("notes.txt", 1), file("readme.md", 0), file("photo.png", 0)], NOW)).toEqual({ state: "none" });
  });

  it("is fresh when the newest dump is within the limit (7 days by default)", () => {
    expect(DEFAULT_MAX_AGE_DAYS).toBe(7);
    expect(backupStatus([file("db.dump", 3)], NOW)).toMatchObject({ state: "fresh", newest: "db.dump", ageDays: 3 });
    expect(backupStatus([file("db.dump", 7)], NOW)).toMatchObject({ state: "fresh" });
  });

  it("is stale beyond the limit", () => {
    expect(backupStatus([file("db.dump", 8)], NOW)).toMatchObject({ state: "stale", ageDays: 8 });
  });

  it("looks at the newest dump, whatever the order", () => {
    const s = backupStatus([file("old.sql", 40), file("new.sql.gz", 2), file("mid.zip", 10)], NOW);
    expect(s).toMatchObject({ state: "fresh", newest: "new.sql.gz", ageDays: 2 });
  });

  it("follows BACKUP_MAX_AGE_DAYS", () => {
    expect(backupStatus([file("a.sql", 5)], NOW, 3)).toMatchObject({ state: "stale", maxAgeDays: 3 });
    expect(backupStatus([file("a.sql", 5)], NOW, 30)).toMatchObject({ state: "fresh" });
  });

  it("never reports a negative age (a clock a little behind)", () => {
    expect(backupStatus([{ name: "a.sql", mtimeMs: NOW + 5000 }], NOW)).toMatchObject({ state: "fresh", ageDays: 0 });
  });

  it("recognizes the usual dump file names", () => {
    for (const n of ["data.sql", "roles.sql", "schema.sql", "x.dump", "x.backup", "x.sql.gz", "x.tar", "x.tgz", "x.zip", "2026-10-20/data.sql"]) expect(DUMP_FILE.test(n), n).toBe(true);
    for (const n of ["x.txt", "x.json", "x.png", "sql", "dump.txt"]) expect(DUMP_FILE.test(n), n).toBe(false);
  });
});

describe("formatBackupStatus", () => {
  it("tells you to take one when there is none, with the reminders", () => {
    const text = formatBackupStatus({ state: "none" }, "/home/me/backups");
    expect(text).toMatch(/No dump found in \/home\/me\/backups/);
    expect(text).toContain("docs/BACKUP.md");
    for (const r of REMINDERS) expect(text).toContain(r);
  });

  it("names the newest file and its age", () => {
    expect(formatBackupStatus({ state: "stale", newest: "a.sql", ageDays: 12, maxAgeDays: 7 }, "b")).toMatch(/a\.sql, 12 days old \(more than 7\)/);
    expect(formatBackupStatus({ state: "fresh", newest: "a.sql", ageDays: 1, maxAgeDays: 7 }, "b")).toMatch(/a\.sql, 1 day old: fresh enough/);
  });

  it("the reminders cover personal data, storage files, restore practice and when to dump", () => {
    const all = REMINDERS.join("\n");
    for (const part of [/personal data/i, /storage files/i, /restore/i, /before every migration/i]) expect(all).toMatch(part);
  });
});

describe("docs/BACKUP.md", () => {
  const doc = readFileSync(new URL("../../docs/BACKUP.md", import.meta.url), "utf8");

  it("explains how to take and how to restore a manual dump", () => {
    expect(doc).toMatch(/supabase db dump --db-url "\$DB_URL" -f roles\.sql --role-only/);
    expect(doc).toMatch(/supabase db dump --db-url "\$DB_URL" -f schema\.sql/);
    expect(doc).toMatch(/--use-copy --data-only/);
    expect(doc).toMatch(/--single-transaction/);
    expect(doc).toMatch(/ON_ERROR_STOP=1/);
    expect(doc).toMatch(/new\*\* Supabase project, never over the live one/);
  });

  it("says what the plan's backups cover and what they do not, with the numbers from Supabase's docs", () => {
    expect(doc).toMatch(/last 7 days/);
    expect(doc).toMatch(/last 14 days/);
    expect(doc).toMatch(/Up to 30 days/);
    expect(doc).toMatch(/Storage files/);
    expect(doc).toMatch(/not in any database backup/);
    expect(doc).toMatch(/Point-in-time recovery|PITR/i);
  });

  it("mentions the personal data in a dump, the check script and the practice restore", () => {
    expect(doc).toMatch(/personal data/i);
    expect(doc).toContain("npm run backup:check");
    expect(doc).toMatch(/Practise it/);
    expect(doc).toMatch(/Delete a person's data/);
  });

  it("the dump folder is ignored by git, and both scripts are in package.json", () => {
    expect(readFileSync(new URL("../../.gitignore", import.meta.url), "utf8")).toMatch(/^\/backups\/$/m);
    const scripts = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(scripts["backup:check"]).toBe("tsx scripts/backup-check.ts");
    expect(scripts["check-rls"]).toBe("tsx scripts/check-rls.ts");
  });
});
