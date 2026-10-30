# Deploying on Vercel Hobby (free)

The app runs on Vercel's free **Hobby** plan. Hobby runs a cron job at most once a day (a more frequent expression makes the deployment fail), so `vercel.json` has **no crons**. Instead, two GitHub Actions workflows call the cron routes over HTTPS:

| Workflow | Job | Schedule (UTC) | IST (UTC + 5:30) |
|---|---|---|---|
| `.github/workflows/pipeline.yml` | ingest | `0 5,17 * * *`: 05:00, 17:00 | 10:30, 22:30 |
| | classify | `30 5,17 * * *`: 05:30, 17:30 | 11:00, 23:00 |
| | write | `0 2,6,10,14,18,22 * * *`: every 4 hours | 07:30, 11:30, 15:30, ... |
| | image | `30 2,6,10,14,18,22 * * *`: every 4 hours, 30 min after write | 08:00, 12:00, 16:00, ... |
| | factcheck | `0 3,7,11,15,19,23 * * *`: every 4 hours, 1 hour after write | 08:30, 12:30, 16:30, ... |
| | cleanup (applied) | `15 1 * * 0`: Sundays 01:15 | Sundays 06:45 |
| `.github/workflows/digest.yml` | digest-draft | `0 3 * * 1`: Mondays 03:00 | Mondays 08:30 |
| | digest-send | `30 5 * * 1`: Mondays 05:30 | Mondays 11:00 |

Each run calls `GET <SITE_URL>/api/cron/<job>` with `Authorization: Bearer <CRON_SECRET>`, prints the response and the HTTP status, and fails on anything other than 2xx. That includes 409, which means the stage was already running, for example while an admin pressed "Run next batch". Both workflows can also be run by hand (Actions tab > the workflow > **Run workflow**, then choose the job). `cleanup-dry-run` counts what the cleanup would touch without changing anything.

Do not add these jobs to `vercel.json` as well: every job would run twice. `lib/deploy.test.ts` fails if `vercel.json` gets a cron, or if any other workflow calls the cron routes.

## Before you start

- **Plan terms.** Vercel's Hobby plan is meant for personal, non-commercial projects. A newsroom run for a company may need **Pro**. Read Vercel's current fair-use and plan terms before you rely on Hobby.
- **Limits that matter here** (Vercel docs; the README's "Deploying" section has the dates read):
  - functions run for at most 300 s on Hobby: the cron routes use 60 s, the review page 300 s;
  - a request body to a function is limited to about 4.5 MB: a Write story with many large images can be refused (the form says so and keeps the draft).
- **GitHub schedules:**
  - they run in UTC, on the default branch only;
  - they can start some minutes late when GitHub is busy;
  - in a public repository they are switched off after 60 days without repository activity.
  - Use a **private** repository. Private repositories get 2,000 free Actions minutes a month; the jobs above are about 22 runs a day, roughly 700 billed minutes a month (each run is rounded up to a minute).
- **Throughput.** A call handles what fits in one run (`BATCH_LIMIT` items per chunk until `STAGE_TIME_BUDGET_MS`, 50 s by default). With write, image and fact-check six times a day, a busy day can leave a queue. Run a stage by hand from the Actions tab, or shorten the schedules in `pipeline.yml`. Keep each one at least every 5 minutes or slower: that is GitHub's minimum.

## 1. Database

Build the Supabase project first: README, "Deploying" > "1. The database". A new project needs `supabase/schema.sql`, then `supabase/seed.sql`. Do the Supabase Auth settings in the README's launch checklist as well: sign-ups off, admins invited, Site URL and redirect URLs set to the production domain.

## 2. Push the code to GitHub without secrets

1. `.gitignore` already excludes:
   - `.env*` (but not `.env.example`)
   - `.next/` and `node_modules/`
   - `*.log` and `/logs/`
   - `.vercel` and `/backups/`
   - browser-test output
2. Before the first commit:
   ```powershell
   git init
   git add .
   git status                     # .env.local, .next, node_modules must NOT be listed
   git check-ignore -v .env.local # must print the .gitignore rule that matches it
   ```
3. If the repository already has history, look for secrets in **every** commit, not only the current files:
   ```powershell
   git log --all -p | Select-String -Pattern 'sb_secret_|eyJhbGciOi|AIza[0-9A-Za-z_-]{30}|sk-ant-|gsk_|BEGIN [A-Z ]*PRIVATE KEY|CRON_SECRET=.{16}|SMTP_PASS=.' | Select-Object -First 20
   git log --all --diff-filter=A --name-only --format="" | Select-String '(^|/)\.env'
   ```
   Both must print nothing. A scanner such as gitleaks (`gitleaks git .`) does the same more thoroughly.

   If a secret was ever committed, deleting the file is not enough: anyone with a clone still has it. Rotate the secret:
   - the Supabase service-role key;
   - the LLM, Unsplash, SMTP or Graph and Turnstile keys;
   - `CRON_SECRET`, which also signs admin sessions.

   Rewrite the history afterwards only if you must; rotation comes first.
4. Push to a **private** GitHub repository.

## 3. Create the Vercel project

1. Vercel > Add New > Project > import the repository. Framework: Next.js (detected). Build command `npm run build`, output directory default. No root-directory change.
2. Set the environment variables (section 4) for the **Production** environment before the first deploy. `CSP_MODE` and `NEXT_PUBLIC_*` are read at **build** time: after changing them, deploy again.
3. Deploy. A Git push to the default branch deploys again from then on.
4. Settings > Domains: add your domain if you have one. `SITE_URL` must be the address people use, with https.
5. Optional: put the production check in front of the build. Change the Build Command to `npm run check-env -- --production && npm run build`. It then fails the deployment when a variable is missing or unsafe.

## 4. Environment variables (Vercel > Settings > Environment Variables, Production)

**Required**

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<project>.supabase.co` (Supabase > Settings > API) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the anon / publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | the service-role / secret key. Server-only: never in a `NEXT_PUBLIC_` variable |
| `CRON_SECRET` | at least 32 random characters (`openssl rand -hex 32`). The **same value** goes into the GitHub secret. It also signs the admin session cookie |
| `SITE_URL` | `https://your-domain` (or `https://<project>.vercel.app`): links in emails, and the GitHub secret of the same name |
| `ADMIN_EMAILS` | comma-separated company addresses, each invited in Supabase Auth |
| `ALLOWED_EMAIL_DOMAINS` | the company domain(s) allowed on `/submit` (empty would accept any address, flagged unverified) |
| `PRIVACY_CONTACT` | an address that is read; shown on `/submit` |
| `LLM_PROVIDER` | `gemini` or `anthropic` (classify, and write and fact-check unless set below) |
| `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` | the key of `LLM_PROVIDER` |
| `UNSPLASH_ACCESS_KEY` | for the image stage |

**Free-tier writer and fact-checker (optional)**

| Variable | Value |
|---|---|
| `WRITE_LLM_PROVIDER`, `FACTCHECK_LLM_PROVIDER` | `groq` to use Groq for those stages (default: `LLM_PROVIDER`) |
| `GROQ_API_KEY`, `GROQ_MODEL` | the Groq key and a model from Groq's model list (README, "Write and fact-check on a free tier") |

**Email: the weekly digest and failure alerts (optional; `none` turns both off)**

| Variable | Value |
|---|---|
| `EMAIL_PROVIDER` | `smtp`, `graph` or `none` (default `none`) |
| `MAIL_FROM` | the sender address |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | with `smtp`. Paste `SMTP_PASS` raw in Vercel (no quotes) |
| `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` | with `graph` (Microsoft 365) |
| `DIGEST_TO` | the distribution list that receives the digest |
| `DIGEST_CONTACT` | shown in the digest footer |
| `DIGEST_MAX_STORIES` | default 6 |

**Security and privacy (optional, with defaults)**

| Variable | Default / value |
|---|---|
| `CSP_MODE` | `report-only` for the first days, then `enforce` (build time) |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` | both to turn Cloudflare Turnstile on for `/submit`, neither to leave it off |
| `SUBMISSION_HASH_SALT`, `ADMIN_SESSION_SECRET` | 16+ characters each; fall back to `CRON_SECRET` |
| `ADMIN_IDLE_MINUTES`, `ADMIN_SESSION_HOURS` | 30, 8 |
| `SUBMITTER_IP_RETENTION_DAYS`, `SUBMITTER_EMAIL_RETENTION_DAYS` | 7, 90 |

**Pipeline tuning (optional, with defaults)**

`BATCH_LIMIT`, `STAGE_CHUNK_SIZE`, `STAGE_DELAY_MS`, `STAGE_TIME_BUDGET_MS` (keep it under 60000: the cron routes end at 60 s), `LLM_TIMEOUT_MS`, `DAILY_BUDGET_USD`, `MAX_ITEMS_PER_FEED`, `RELEVANCE_THRESHOLD`, `MAX_ITEM_AGE_DAYS`, `KEYWORD_PRECHECK`, `MIN_SOURCE_WORDS`, `FETCH_USER_AGENT`, `FETCH_TIMEOUT_MS`, `IMAGE_PROVIDER`. Their defaults and ranges are in `.env.example`.

**Do not set on Vercel**

- `APP_URL`: local scripts only; the production check refuses it.
- `HOST`, `PORT`, `SELF_HOST_ADMIN`: the Windows self-host server only.
- `PEXELS_API_KEY` and any other key the app does not read.

`npm run check-env -- --production` checks this list against your `.env.local` (and `.env.production*`) and the process environment.

## 5. Turn on the scheduled jobs (GitHub)

1. GitHub repository > Settings > Secrets and variables > Actions > **New repository secret**:
   - `SITE_URL`: `https://your-domain`, no trailing slash, https only (the workflow refuses anything else);
   - `CRON_SECRET`: exactly the value in Vercel.
2. Actions tab: if GitHub asks, enable workflows for the repository.
3. Actions > **Pipeline** > Run workflow > `ingest`. The log shows `Calling /api/cron/ingest`, the JSON answer and `HTTP status: 200`.
   - `401`: the two `CRON_SECRET` values differ.
   - `000`: the address can't be reached.
   - `404`: `SITE_URL` points at the wrong site.
4. Run `classify`, `write`, `image` and `factcheck` the same way once, then `cleanup-dry-run`. Run **Weekly digest** > `digest-draft` once if email is set up.
5. Leave the schedules to run. Failed runs show in the Actions tab, and GitHub emails the person who last changed the workflow file.

The digest: `digest-draft` makes this week's draft on Monday morning. An admin approves it in `/admin/digest`, then `digest-send` sends it 2.5 hours later. A draft that is not approved is **not** sent; the admins get a reminder instead.

## 6. Check the deployment

1. `curl -H "Authorization: Bearer <CRON_SECRET>" https://your-domain/api/cron/health`: it lists anything still missing.
2. `npm run check-rls` (with the production Supabase URL and anon key in your local environment): the public key reads only published articles and department names.
3. Sign in to `/admin` with an invited address; check `/admin/review` and the Pipeline tab after the first scheduled runs.
4. Then follow the rest of the README's launch checklist: purge the sample data, back up, try a test digest, and switch `CSP_MODE` to `enforce` after a few quiet days.

## Moving to Pro later

On Pro, Vercel's cron can run every minute. Move the schedules into `vercel.json` (`"crons": [{ "path": "/api/cron/ingest", "schedule": "..." }, ...]`), then disable or delete the two workflows. Vercel sends `CRON_SECRET` as the bearer token by itself. Update `lib/deploy.test.ts`, which checks the Hobby setup.
