# Backups: taking, restoring and checking them

Audit item DB-04. Facts about Supabase come from its documentation (pages "Database Backups", updated for 2026, and "Backup and Restore using the CLI"); check those pages again before you rely on a number here.

## What the plan's backups cover

| Plan | Automatic daily backups | Point-in-time recovery |
|---|---|---|
| Free | Not described as part of the plan. Supabase recommends that free projects "regularly export their data" with `supabase db dump` and keep copies off-site. | No |
| Pro | The last 7 days | Paid add-on (needs at least a Small compute add-on); turning it on stops the daily backups |
| Team | The last 14 days | Paid add-on |
| Enterprise | Up to 30 days | Paid add-on |

Daily backups and their restore are in the dashboard under **Database > Backups**. What they do **not** cover:

- **Storage files.** The database holds only the metadata of what is in Storage. The photos of employee stories (`submission-images` private, `article-images` public) are not in any database backup, and restoring an old backup does not bring back a file deleted after it.
- **Passwords of custom database roles** (set them again with `ALTER USER` after a restore).
- Things that live outside the database: environment variables (keep a copy of the production list in your password manager), the Vercel project settings, the Supabase Auth settings (sign-ups off, redirect URLs, MFA, SMTP) and the invited admin users' project-level configuration.

Before the launch, check on the Supabase dashboard (Database > Backups) which of these your plan gives you, and write the answer here: `Plan: ______  Daily backups kept: ____ days  PITR: yes/no  Checked on: ______`.

## Take a manual dump

Do it before every migration, before the launch, after a large import, and weekly if the plan has no daily backups.

1. Get the connection string: Supabase dashboard > **Connect** > the **Session pooler** string (use the direct string only if your network has IPv6 or you have the IPv4 add-on). It contains the database password: do not commit it, do not paste it into chat.
2. From a folder **outside the repository** (or `backups/`, which `.gitignore` excludes):

```bash
mkdir -p backups/2026-10-20 && cd backups/2026-10-20
supabase db dump --db-url "$DB_URL" -f roles.sql --role-only
supabase db dump --db-url "$DB_URL" -f schema.sql
supabase db dump --db-url "$DB_URL" -f data.sql --use-copy --data-only
```

(`$DB_URL` is the connection string. The Supabase CLI is `npm i -g supabase` or `npx supabase`. On Windows PowerShell use `$env:DB_URL`.)

3. Keep the three files together in a folder named by the date, **encrypt** it, and copy it somewhere that is not the same laptop (company file share, an encrypted cloud folder). It contains personal data: author emails, hashed network addresses, digest recipients, admin emails in the logs.
4. Delete old dumps. A dump made last month still holds data that the cleanup job has since anonymized, and a person you deleted with **Delete a person's data** is still in older dumps. Keep dumps for as short a time as you can live with (a month is a reasonable limit), and say so in your answer to anyone who asks.
5. Run `npm run backup:check`. It looks in `backups/` (or the folder in `BACKUP_DIR`) for a dump newer than 7 days (`BACKUP_MAX_AGE_DAYS`), and prints these reminders. `npm run backup:check -- --strict` exits with an error when there is none, so it can sit in a calendar reminder script or a CI job.

### Photos

Copy the two buckets too. The simplest reliable way is a small script with `@supabase/supabase-js` and the service-role key that lists each bucket (`storage.from(bucket).list`) and downloads each file (`download`) into `backups/<date>/storage/<bucket>/`. There are few files (one optional photo per employee story). The `article-images` bucket holds copies of the photos of published stories; `submission-images` holds the originals, including those of stories not yet decided.

## Restore

Restore into a **new** Supabase project, never over the live one.

1. Create a new project (same region). Note its connection string and keys.
2. Restore the database (this is the documented command):

```bash
psql \
  --single-transaction \
  --variable ON_ERROR_STOP=1 \
  --file roles.sql \
  --file schema.sql \
  --command 'SET session_replication_role = replica' \
  --file data.sql \
  --dbname "$NEW_DB_URL"
```

3. Set the passwords of any custom roles, enable the extensions the old project used, and re-enable anything the dump does not carry (Realtime publications, database webhooks).
4. Recreate the Storage buckets if they are missing (`supabase/schema.sql`, section "Storage", does it) and upload the files from your copy.
5. Point the app at the new project: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (Vercel project settings, then redeploy). Set the Auth options again (sign-ups off, site URL and redirect URLs, SMTP), and invite the admins.
6. Check it: `npm run check-env -- --production`, then `GET /api/cron/health` with the cron secret (it lists any missing table, column, bucket or grant and the file that fixes it), then `npm run check-rls`.
7. Open the site and `/admin/review`, and send yourself a digest test.

### Practise it

Once a quarter restore the newest dump into a throwaway project and walk through steps 2 to 7. Write the date and how long it took below. A backup that has never been restored is a hope, not a backup.

| Date | Dump used | Restored OK? | Minutes | Notes |
|---|---|---|---|---|
| | | | | |

## If a person asked to be forgotten

**Delete a person's data** (admin > Privacy) removes them from the live database and storage. It cannot reach your dumps or Supabase's own daily backups (they age out after the plan's retention period). Delete your manual dumps that predate the request when you can, or note the date they will be deleted.
