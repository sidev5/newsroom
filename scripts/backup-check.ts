// npm run backup:check [-- --strict]: looks for a recent manual dump (folder BACKUP_DIR, default ./backups; limit BACKUP_MAX_AGE_DAYS,
// default 7) and prints the reminders from docs/BACKUP.md. With --strict the exit code is 1 when there is none or it is stale.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { backupStatus, DEFAULT_MAX_AGE_DAYS, formatBackupStatus, type BackupFile } from "../lib/maintenance/backup-check";

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const unknown = args.filter((a) => a !== "--strict");
if (unknown.length > 0) {
  console.error(`Unknown option: ${unknown.join(" ")}. Usage: npm run backup:check [-- --strict]`);
  process.exit(1);
}

const dir = resolve(process.env.BACKUP_DIR ?? "backups");
const maxAge = Number(process.env.BACKUP_MAX_AGE_DAYS ?? DEFAULT_MAX_AGE_DAYS);

const files: BackupFile[] = [];
if (existsSync(dir)) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile()) files.push({ name: entry.name, mtimeMs: statSync(path).mtimeMs });
    // one level down: a dump can be a folder (roles.sql, schema.sql, data.sql) named by date
    else if (entry.isDirectory()) {
      for (const inner of readdirSync(path, { withFileTypes: true })) {
        if (inner.isFile()) files.push({ name: `${entry.name}/${inner.name}`, mtimeMs: statSync(join(path, inner.name)).mtimeMs });
      }
    }
  }
}

const status = backupStatus(files, Date.now(), Number.isFinite(maxAge) && maxAge > 0 ? maxAge : DEFAULT_MAX_AGE_DAYS);
console.log(formatBackupStatus(status, dir));
if (strict && status.state !== "fresh") process.exit(1);