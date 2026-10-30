// `npm run backup:check`: is there a recent manual database dump? Pure, so the verdicts can be tested; the script (scripts/backup-check.ts)
// lists the files. See docs/BACKUP.md.

export type BackupFile = { name: string; mtimeMs: number };

export type BackupStatus =
  | { state: "none" }
  | { state: "fresh" | "stale"; newest: string; ageDays: number; maxAgeDays: number };

/** Files that look like a dump of the database. */
export const DUMP_FILE = /\.(sql|dump|backup|gz|tgz|tar|zip|7z)$/i;

export const DEFAULT_MAX_AGE_DAYS = 7;

export function backupStatus(files: BackupFile[], now: number, maxAgeDays: number = DEFAULT_MAX_AGE_DAYS): BackupStatus {
  const dumps = files.filter((f) => DUMP_FILE.test(f.name));
  if (dumps.length === 0) return { state: "none" };
  const newest = dumps.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
  const ageDays = Math.max(0, (now - newest.mtimeMs) / 86_400_000);
  return { state: ageDays > maxAgeDays ? "stale" : "fresh", newest: newest.name, ageDays: Math.floor(ageDays), maxAgeDays };
}

export const REMINDERS = [
  "A dump holds personal data (author emails, hashed addresses, digest recipients): keep it outside the repository, encrypted, and delete old ones.",
  "Storage files (photos) are NOT in a database dump: the buckets need their own copy (see docs/BACKUP.md).",
  "A backup you have never restored is a hope: restore one into a throwaway project every quarter.",
  "Take a fresh dump before every migration, before the launch, and after a large import.",
];

export function formatBackupStatus(status: BackupStatus, dir: string): string {
  const head =
    status.state === "none"
      ? `No dump found in ${dir}. Take one now: see docs/BACKUP.md ("Take a manual dump").`
      : status.state === "stale"
        ? `The newest dump in ${dir} is ${status.newest}, ${status.ageDays} days old (more than ${status.maxAgeDays}). Take a new one: see docs/BACKUP.md.`
        : `The newest dump in ${dir} is ${status.newest}, ${status.ageDays} ${status.ageDays === 1 ? "day" : "days"} old: fresh enough (limit ${status.maxAgeDays} days).`;
  return [head, "", "Remember:", ...REMINDERS.map((r) => `  - ${r}`)].join("\n");
}