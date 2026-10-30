# Audit of the Company Newsroom app

Date: 2026-10-15. Scope: the repository at `E:\Newspaper\newsroom` and the Supabase project its `.env.local` points to.
Mode: read-only. The only project file I created is this one. `next build` regenerated `.next/` (a build artifact). Scratch scripts are outside the repo.

## How this was checked

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `eslint` | clean |
| `vitest run` | 33 files, 645 tests, all pass |
| `next build` | OK. Next 16 no longer prints "First Load JS"; I measured the production build instead (see Performance) |
| `npm audit` | 5 "high", all dev-only and one chain: `eslint-config-next` > `@next/eslint-plugin-next` > `fast-glob` > `micromatch` > `braces` (stack-exhaustion DoS on deeply nested glob patterns). 0 in runtime dependencies |
| `npm outdated` | `next` 16.3.8 (16.4.1 available), `react`/`react-dom` 19.2.8 (19.3.1), `zod` 4.6.5 (4.6.7), `@google/genai` 2.25.0 (2.30.0), `@supabase/supabase-js` 2.117.2 (.3). No advisories reported for them |
| Secrets in source | none in tracked source. Real keys exist only in `.env.local`, which `.gitignore:34-35` excludes (`.env*`, with `.env.example` allowed). There is no git repository here (`.git` absent, `git` not installed), so there is no history to scan |
| Live database probes | queried every table with the publishable (anon) key; compared row counts with the service-role key (read-only). Writes were tested only with `PATCH`/`DELETE` filters that match nothing, so no data changed. I did **not** test `INSERT` (it could write) |
| Browser measurements | Chrome driven by Playwright against my own app: dev server `localhost:3000`, and a temporary `next start` on `localhost:3100` that I stopped afterwards |

**Not verifiable from here** (needs the Supabase/Vercel dashboards): JWT expiry, inactivity/time-box session limits, whether MFA is enabled for the project, backups/PITR, custom SMTP, the list of storage and table policies. To check RLS and policies directly, run in the SQL editor:

```sql
select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1;
select schemaname, tablename, policyname, cmd, roles from pg_policies where schemaname in ('public','storage') order by 1,2;
```

**Housekeeping note:** my secret-scan grep printed lines of `.env.local` into this session's output (Supabase keys, `SMTP_PASS`). The values are not in this report. If this session's transcript is stored anywhere you do not control, rotate the SMTP password and the Supabase service-role key (finding SEC-11).

---

## (a) The 10 most important findings

1. **SEC-01 (High): an admin's email address is publicly readable.** The restore flow writes `Restored by editor (<admin email>)` into `articles.review_note`, and the anon key can read every column of published articles. Live: 2 published rows leak it.
2. **ADM-03 / DB-01 (High): the audit-log and pipeline-run tables do not exist in the live database.** `review_log` and `pipeline_runs` return `PGRST205`. Approvals and rejections are not being logged, and the Pipeline tab has no history.
3. **DEP-02 (High): `SMTP_PASS` loads as an empty string.** It starts with `#`, so dotenv treats it as a comment. This is almost certainly why the live digest has a `send_failed` entry and is stuck in `approved`.
4. **SEC-03 (Medium): public sign-ups are enabled** (`disable_signup: false`), although the README's setup step 3 says to turn them off.
5. **SEC-06 (Medium): `/submit` accepts any email address in the current configuration** (`ALLOWED_EMAIL_DOMAINS` is not set), and the abuse limits only count accepted stories.
6. **SEC-02 (Medium): the anon key reads internal columns** of published articles: `fact_check_notes`, `review_note`, `image_query`, `raw_item_id`, `department_id`.
7. **SEC-05 (Medium): no security headers** (no CSP, frame protection, Referrer-Policy, Permissions-Policy, HSTS), and `X-Powered-By: Next.js` is sent.
8. **ADM-01 / ADM-02 (Medium): no logout button, a 400-day non-HttpOnly session cookie, no MFA, no idle timeout.**
9. **DEP-01 (High for deployment): `vercel.json` cannot deploy on the Hobby plan** (hourly crons; `maxDuration = 300` on the review page).
10. **PERF-01 / PERF-02 (Medium): the homepage loads up to 300 full stories on every visit with no caching, and the globe runs at about 13 fps on a throttled phone.**

---

## (b) All findings

Severity: Critical / High / Medium / Low. Effort: S (under half a day), M (1-3 days), L (more). Paths are relative to the repo root.

### Security and privacy

| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| SEC-01 | High | Admin email leaks through the public API. `restoreNote` embeds the admin's address in `review_note`; that column is anon-readable on published rows. Live check: 6 published rows visible to anon, 2 have `review_note`/`fact_check_notes` containing an email. | `lib/admin/recover.ts:118-124` (note text), `:188` (stored); `supabase/schema.sql:124-128` (policy exposes whole row) | Stop writing the email (say "an editor"; the address is already in `review_log`). Clear existing rows: `update articles set review_note = regexp_replace(review_note, '\([^)]*@[^)]*\)', '(an editor)') where review_note like '%@%'`. Combine with SEC-02. | S |
| SEC-02 | Medium | The anon key can read all columns of every published article, including internal ones: `fact_check_notes`, `review_note`, `image_query`, `raw_item_id`, `department_id`, and three unused columns `reviewed_by`, `reviewed_at`, `previous_status`. The app's own query lists columns (`lib/news/queries.ts:9-10`), but anyone with the public key can call the REST API directly. | `supabase/schema.sql:124-128`; live `GET /rest/v1/articles?select=*` as anon returned 30 columns | Column-level grants (`revoke select on articles from anon; grant select (id, slug, headline, body, ...) on articles to anon;`) or a `published_articles` view with only the public columns; point `lib/news/queries.ts` at it. Update `lib/admin/schema-check.ts` accordingly. | M |
| SEC-03 | Medium | Public sign-ups are on: `GET /auth/v1/settings` shows `disable_signup: false`, email provider enabled. A stranger can create accounts with the public anon key (spam, quota use of Supabase's built-in mailer). The `ADMIN_EMAILS` check still blocks `/admin`, and email confirmation is required (`mailer_autoconfirm: false`). | README.md:34-40 (says to disable); live auth settings | Supabase dashboard: Authentication > Sign In / Providers > Email > turn off "Allow new users to sign up". Admins are invited. | S |
| SEC-04 | Low | Anon key can `PATCH`/`DELETE` nothing today: 204 with zero rows on every table (RLS hides rows) and `42501` on `article_submitters` (privileges revoked). OK. But `INSERT` was not tested and the live policy list could not be read; verify with the SQL above. | live probe | Run the two SQL queries above once; keep them as a post-deploy check. | S |
| SEC-05 | Medium | No HTTP security headers. `next.config.ts` sets none; the response of `/` carries only `Vary`, `Link`, `Cache-Control`, `X-Powered-By: Next.js`. Missing: `Content-Security-Policy`, `X-Frame-Options`/`frame-ancestors`, `Referrer-Policy`, `Permissions-Policy`, `X-Content-Type-Options`. (Vercel adds HSTS on `*.vercel.app`; custom domains need it set.) | `next.config.ts:15-26`; measured headers on `localhost:3100/` | Add `headers()` with the above and `poweredByHeader: false`. A strict CSP needs nonces because Next injects inline scripts; start with `frame-ancestors 'none'`, `base-uri`, `object-src 'none'`, `img-src` limited to self, `images.unsplash.com`, the Supabase host. | M |
| SEC-06 | Medium | `/submit` abuse protection is thin in the current config. (1) `ALLOWED_EMAIL_DOMAINS` is not set in `.env.local`, so any email is accepted (flagged "unverified") and the per-email limit is bypassed by changing the email; only 3/IP/day remains. (2) The limits count accepted stories only; invalid or oversized posts are not limited at all, and every server action accepts a 6 MB body. (3) The client IP is the first `x-forwarded-for` entry, which a client can set when the app is not behind a proxy that overwrites it (Vercel does overwrite). (4) No CAPTCHA. Live: 1 submitter row, `email_verified = false`, and the story was published, so the flow ran with no domain check. | `lib/submissions/identity.ts:37-38`; `lib/submissions/service.ts` (limits run after validation); `next.config.ts:24`; `.env.local` (no `ALLOWED_EMAIL_DOMAINS`) | Set `ALLOWED_EMAIL_DOMAINS` before the launch. Add a Vercel WAF/rate-limit rule on `POST /submit`. Add Cloudflare Turnstile if abuse appears. Document that the host must overwrite `x-forwarded-for`. | S (config) / M (CAPTCHA) |
| SEC-07 | Medium | Ingest fetches URLs taken from RSS items (`item.url`) with `redirect: "follow"` and no check of the target address. A malicious or compromised feed could point at internal hosts (SSRF), and redirects can lead anywhere. Limits that do exist: 3 MB response cap, 10 s timeout, robots.txt check. | `lib/ingest/fetch.ts:15-19`; `lib/pipeline/ingest.ts:50` (item URL), `:68` (feed URL) | Resolve the host and refuse private, loopback and link-local ranges before each request and after each redirect (`redirect: "manual"` with a hop limit); allow only http(s) on ports 80/443. Low risk on Vercel (no internal network) but cheap insurance. | M |
| SEC-08 | Low | Prompt injection through RSS text. `neutralise()` only strips the wrapper tags; instructions inside the article are not removed (the prompts tell the model to treat it as data). Worst realistic outcome: a misleading or off-topic draft, a wrong department/country, or wasted tokens. It cannot publish: a human approves, though bulk approve publishes "as stored" without reading. The fact-check compares the draft with the same (possibly poisoned) source, so it cannot catch a lie that is in the source. Model output is validated by zod; country codes are checked against a static list. | `lib/pipeline/untrusted.ts:5-7`; `lib/pipeline/classify.ts` (prompts); `lib/admin/review.ts` (`bulkApprove`) | Keep human approval mandatory. Consider a warning on bulk approve when the item has not been opened, and flag items whose text contains instruction-like phrases. | S |
| SEC-09 | Low | `?error=` and `?notice=` are rendered in admin pages. React escapes them (no XSS), but a crafted link can show an admin an arbitrary message (content spoofing). | `app/admin/(protected)/review/page.tsx:94-96`; `app/admin/(protected)/digest/page.tsx:25-26`; `app/admin/(protected)/actions.ts:25-32` | Pass short codes and map them to fixed texts, or sign the message. | S |
| SEC-10 | Low | `npm audit`: 5 dev-only highs in the `eslint-config-next` chain. `npm audit fix --force` would downgrade `eslint-config-next` to 14.x, which is wrong for Next 16. Not shipped to production. | `package.json` devDependencies | Ignore until `eslint-config-next` updates; upgrade `next` to 16.4.x with the usual patch cadence. | S |
| SEC-11 | Low | Secrets handling: real keys are in `.env.local` (correctly git-ignored). My scan printed them to this session. Also: `PEXELS_API_KEY` is a placeholder for a provider the code does not use. | `.env.local:13`, `:50`; `.gitignore:34-35` | Rotate `SMTP_PASS` and (if the transcript is retained) the Supabase service-role key. Remove unused variables. | S |
| SEC-12 | Low | Admin source links render stored URLs without `safeHttpUrl`. Safe today because `normalizeUrl` only admits http(s), but it relies on that single place. | `app/admin/(protected)/review/PendingBoard.tsx:142`, `RecoverBoards.tsx:164,251`, `review/page.tsx:49` | Wrap with `safeHttpUrl` (already used on public pages). | S |
| SEC-13 | Medium | Personal data has no retention rule or notice. `article_submitters` keeps the email and IP hash forever (the 24 h limit window needs only 24 h of IP hashes). `/submit` shows no privacy notice. `digest_recipients` holds emails in plain text. | `supabase/schema.sql` (`article_submitters`); `app/submit/page.tsx` | Add a short privacy notice on `/submit`; purge `ip_hash` after 7 days and the email N days after the decision (scheduled SQL or a cron route). See "Data-protection note" below. | M |

**OK (no finding):**
- Cron auth: `isAuthorizedCron` is timing-safe, requires 16+ characters, never accepts a missing secret (`lib/cron-auth.ts:11-18`; live secret is 33 characters). All 8 cron routes call `rejectUnlessCron`; unauthenticated requests get 401.
- Service-role key: only imported through `lib/supabase/admin.ts` (`server-only`); a test fails if a public file imports it. No `NEXT_PUBLIC_` misuse (only the URL and the anon key).
- XSS: no `dangerouslySetInnerHTML`/`innerHTML`/`eval` in app code. Employee text and RSS text are stored as text and escaped by React and by `esc()` in the email. The email preview iframe is `sandbox=""` (`DigestEditor.tsx:186`).
- Open redirects: all `redirect()` targets are fixed paths.
- CSRF: server actions use Next's Origin/Host check (documented default); the only GET admin route (`.eml`) is read-only and checks the admin.
- Email: subject is forced to one line, recipients go in BCC batches of 50, logs hold counts and no addresses, SMTP uses STARTTLS with `requireTLS` (`lib/mail/smtp.ts:28-29`), sending is claimed atomically.
- File upload: type by magic bytes, 5 MB limit, 40 MP decode limit, metadata stripped, re-encoded, random object name, private bucket (verified live: `submission-images` private, `article-images` public, size and MIME limits set).
- Private data: `article_submitters` returns `permission denied` to anon (verified). Every existing table other than `departments` and published `articles` returns zero rows to anon while the service role sees them (sources 16, raw_items 92, agent_runs 89, digests 1, digest_recipients 1, digest_log 10, article_submitters 1), so RLS is on for each.
- Unpublished/rejected images: the only images are Unsplash URLs and the public bucket (published only). Photos of pending or rejected submissions sit in the private bucket and are reachable only through 10-minute signed URLs created for admins. Draft and rejected **text** is not readable by anon (live: 0 non-published rows visible).

### Admin area

| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| ADM-01 | Medium | No logout. `signOut` appears nowhere in the code and the admin nav has no sign-out control, so a session can only be ended by clearing cookies. | `app/admin/(protected)/layout.tsx:20-26`; `grep signOut` finds nothing | Add a sign-out server action (`supabase.auth.signOut()` then redirect to `/admin/login`) and a button in the nav. | S |
| ADM-02 | Medium | Session hardening is absent. Cookies come from `@supabase/ssr` defaults: `httpOnly: false`, `sameSite: lax`, `maxAge` 400 days. Login uses the browser client, so the session cookie is script-readable. There is no idle or absolute timeout in the app, no MFA enrolment or AAL2 check (live: the one user has 0 factors). | `lib/supabase/browser.ts:4-9`; `app/admin/login/page.tsx:15-18`; `node_modules/@supabase/ssr/dist/main/utils/constants.js:4-10`; no `aal2`/`mfa` in code | Turn on MFA (TOTP) for admins and require `aal2` in `currentAdminEmail`; set Supabase "Inactivity timeout" and "Time-box" (Pro plan feature) or add an app-side `last seen` check; shorten cookie `maxAge`. A strict CSP (SEC-05) is the main defence for the readable cookie. | M |
| ADM-03 | High | The audit log is not working live: table `review_log` is missing. Every approve/reject/unpublish/restore returns "The change was saved but the audit log entry failed", and `latestLogs` silently returns nothing, so "approved by X" never shows. `pipeline_runs` is missing too, so the Pipeline tab has no "last run". | live `GET /rest/v1/review_log` -> `PGRST205`; `lib/admin/review.ts:91-94`; `lib/admin/recover.ts:95-98`; `lib/pipeline/stages.ts:112-120` | Run `supabase/migrations/2026-10-14_world_review_pipeline.sql` (it is idempotent), then `GET /api/cron/health`. The health check already reports these tables. | S |
| ADM-04 | Low | When the session expires mid-action, the action returns "Not authorised." which is shown as a red banner (or in the Run-batch list); the user is not redirected to the login page until the next navigation. No data is changed. | `app/admin/(protected)/actions.ts:34-37`; `lib/admin/review.ts:35` (`NOT_ADMIN`); `RunBatch.tsx:57` | In `back()`/`done()`, redirect to `/admin/login` when the error is `Not authorised.`. | S |
| ADM-05 | Low | Admin layout and every page/action re-check admin rights (OK). Gaps in confirmation: removing a digest recipient and single Approve/Unpublish have no confirmation; recipient removal cannot be undone. Bulk actions, Send now and Send test do confirm. Reject is restorable. | `app/admin/(protected)/digest/actions.ts`; `lib/digest/recipients.ts:70-77` | Add a confirm step for "Remove recipient"; keep the rest. | S |

**OK:** `proxy.ts` covers `/admin/:path*` (all 5 admin URLs return 307 to the login page unauthenticated, measured); the layout and each page call `currentAdminEmail()` again; every server action and the `.eml` route re-check inside the lib function before using the service role. Audit trail exists for digest actions (`digest_log`, 10 live rows) and, once ADM-03 is fixed, for review actions.

### Database

| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| DB-01 | High | Schema drift on the live database. Missing: tables `review_log`, `pipeline_runs`. Extra, unused by the code: `articles.reviewed_by`, `reviewed_at`, `previous_status`. Every other column the code reads or writes exists (checked table by table). | live probes; `supabase/schema.sql` has no `reviewed_by`; code has no use of it (`previous_status` in code is `review_log.previous_status`) | Run the 2026-10-14 migration. Drop the three extra columns (or document them) once nothing needs them. | S |
| DB-02 | Medium | Foreign keys without indexes: `raw_items.source_id`, `raw_items.department_id`, `articles.department_id`, `sources.department_id`, `agent_runs.article_id`, `agent_runs.raw_item_id`. Deletes/cascades on the parent scan the child table. Harmless at 92 rows; matters at about 100k. The indexes the real queries need do exist: `raw_items(status, fetched_at)`, `articles(status, created_at)`, partial `articles(published_at desc) where status='published'`, `digests(week_start)` unique, `raw_items.url` unique. | `supabase/schema.sql:20-30,35-49,59-81,101-110` | `create index` on those six columns. | S |
| DB-03 | Medium | No retention for growing tables. `raw_items.full_text` averages 5.8 k characters per row (up to 20 k, `lib/ingest/text.ts:3`) and is kept forever, also for skipped items; `agent_runs`, `pipeline_runs`, `digest_log` grow without bound. Estimate at the current feed set: tens of items per day, so the raw table reaches hundreds of MB within a year; the free Supabase plan is 500 MB. | `lib/pipeline/ingest.ts:104-134`; `supabase/schema.sql:35-49` | Null `full_text` once an item is `written`/`skipped` and older than 14 days; delete `raw_items` older than 90 days that have no article; keep `agent_runs` for 12 months. Scheduled with `pg_cron` or a cron route. | M |
| DB-04 | Medium | Backups are unknown. The free plan has no point-in-time recovery; nothing in the repo documents a backup or restore procedure. | n/a (dashboard) | Confirm the plan's backups; before launch take a manual dump; document the restore steps. | S |
| DB-05 | Low | `articles.department_id` and `raw_items.department_id` are `on delete set null`, so deleting a department silently leaves stories with no department. `departments.name` and `slug` are unique (good). | `supabase/schema.sql:66,46` | Use `on delete restrict` for `articles.department_id`. | S |
| DB-06 | Low | Eight of 16 active sources are placeholders (`example.com/replace-me/...`), so each hourly ingest logs 8 failed feeds. | live `sources` (16 active, 8 placeholder); `supabase/seed.sql:25-34` | Deactivate or delete them. | S |

**OK:** status values are constrained by CHECKs (`articles`, `raw_items`, `digests`, `review_log`, `pipeline_runs`, `articles.origin`); one digest per week (`digests_week_start_idx` unique); duplicate links (`raw_items.url` unique, `onConflict: "url"` upsert); `articles.raw_item_id` unique; `digest_log` cascades from `digests`; `article_submitters` cascades from `articles`; the employee author check constraint exists. Public stories query uses the partial published index with a limit.

At 10x data the first things to hurt are DB-03 (storage) and PERF-01 (payload), not query speed.

### Frontend performance

Measured against the production build (`next start`, localhost, 6 published stories). The live data set is small, so list-size effects are **estimated**, not measured.

| Scenario | FCP | LCP | CLS | Long tasks | Globe frame rate |
|---|---|---|---|---|---|
| Desktop 1440x900, DPR 1 | 540 ms | 540 ms | 0 | 0 | 60.2 fps (p95 frame 16.8 ms) |
| Desktop, DPR 2 | 1012 ms* | 1012 ms* | 0 | 0 | 59.3 fps |
| Phone 390x844, DPR 3, CPU 4x slower | 520 ms | 520 ms | 0.0001 | 24 tasks, 2.5 s total, longest 297 ms | 13.1 fps (p95 frame 100 ms) |
| Same + slow 3G (400 ms RTT, 50 KB/s) | 2.7 s | 2.7 s | 0.0054 | 14 tasks, 2.1 s total | 11.8 fps |

\* the DPR 2 run had a slower server response (TTFB 858 ms), not slower rendering.

Page weight (production): HTML 48 KB; 10 script files, 786 KB decoded (largest chunks 253 KB, 224 KB, 132 KB, 62 KB); `countries-110m.json` 105 KB; 3 font files 112 KB; total about 1.12 MB decoded, 20 requests. Heap 33 MB, 233 DOM nodes.

| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| PERF-01 | Medium | The homepage loads up to 300 stories, each with its **full body**, on every request: `force-dynamic`, `Cache-Control: private, no-cache, no-store`. The HTML is 48 KB for 6 stories; at 200-300 stories expect roughly 0.5-1 MB of HTML plus the same data again in the client payload (estimate: about 1.5 KB body per story, serialized twice). Each visit also costs a Supabase query. | `lib/news/queries.ts:55` (`limit = 300`), `:9-10` (selects `body`); `app/page.tsx:6`; `components/dashboard/Dashboard.tsx` receives all stories | List query: select a stored 2-sentence summary (or `left(body, 240)`), load the body when a story is opened (`/article/[slug]` already exists); cap at about 60 and add "load more"; cache the list with `revalidate = 60`. | M |
| PERF-02 | Medium | Globe cost on weak devices. The loop repaints every frame while auto-rotating: a `shadowBlur` glow (24 px x DPR), three gradients, about 177 country paths. DPR is not capped (3 on many phones gives a 0.75 MP canvas, 1.76 MP at DPR 2 on desktop). It pauses on tab hidden but not when scrolled out of view (below 1100 px the globe sits above the feed). Result above: 13 fps and 2.5 s of long tasks on a 4x-throttled phone. Cleanup of listeners and rAF is correct (no leak found). | `components/dashboard/Globe.tsx:204` (DPR), `:233` (`shadowBlur`), `:241-297` (per-frame gradients), `:355` (rAF), `:366` (only `visibilitychange`) | Cap DPR at 2; draw the atmosphere glow once to an offscreen canvas; cache gradients; pause with `IntersectionObserver`; lower the rotation frame rate (30 fps) or stop auto-rotation on `navigator.hardwareConcurrency <= 4`. | M |
| PERF-03 | Low | About 786 KB of JavaScript decoded for the first paint. I did not break the chunks down; the globe stack (d3-geo, topojson-client) is a likely contributor. On slow 3G the load took 7.2 s. | measured above; `components/dashboard/Globe.tsx:3-7` | Load `Globe` with `next/dynamic` after first paint (feed and header render first); inspect the chunks with `@next/bundle-analyzer` before deciding. | M |
| PERF-04 | Low | The feed is not virtualized and filtering runs over the whole array on each keystroke (memoized). At 233 nodes today; with 300 cards expect roughly 3k nodes: acceptable on desktop, noticeable on low-end phones. Not measured. | `components/dashboard/FeedPanel.tsx:82-88`; `Dashboard.tsx:73-74` | Fixed by PERF-01's cap; add `content-visibility: auto` on cards if needed. | S |
| PERF-05 | Low | `/article/[slug]` and `/` query Supabase on every request with no caching, so a traffic spike goes straight to the database. | `app/article/[slug]/page.tsx:12`; `app/page.tsx:6` | `revalidate` 60 s with tag revalidation on approve/unpublish. | S |

**OK:** CLS is 0 (0.0001 on phone). Fonts use `next/font` and are preloaded. Feed cards have no images; the reader uses `next/image` with `sizes`; Unsplash images are requested at 1080 px. Reduced motion is honoured for the globe and ticker (`Globe.tsx:189-192`, `globals.css`). Accessibility basics hold from earlier checks: `lang="en"`, visible focus ring, 44 px targets, labelled form fields and `role="alert"` errors. Minor gaps (Low): no skip link; 11 px monospace labels are small.

### Backend, pipeline and reliability

| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| BE-01 | Medium | Ingest has no time budget. The other four stages stop starting items after `STAGE_TIME_BUDGET_MS`; ingest ignores it. It fetches each new item's page one at a time (up to 10 s each, plus robots.txt), 4 feeds in parallel, inside a function limited to 60 s. If it is cut off nothing is recorded (no `pipeline_runs` row), though inserts already made are safe (`upsert ... ignoreDuplicates`). | `lib/pipeline/stages.ts:90`; `lib/pipeline/ingest.ts:104-134`; `app/api/cron/ingest/route.ts:5` | Pass `deadlineAt` into `runIngest`, stop before it, and report `deferred`. | M |
| BE-02 | Medium | The LLM provider calls have no explicit timeout (the Unsplash call does). A hung provider call burns the whole 60 s function and loses the run record. | `lib/llm/providers/anthropic.ts`, `gemini.ts` (no timeout option); compare `lib/images/unsplash.ts:26` | Set a per-call timeout (about 45 s) and treat it as `transient`. | S |
| BE-03 | Medium | A digest can stay in `sending` forever: if the function is killed after the atomic claim, or the final `sent` update fails after the mail went out, nothing recovers it, and the UI blocks edits and re-sends. Live: the 2026-10-12 digest is `approved` after one `send_failed`. | `lib/digest/service.ts:247-280` | Show "stuck in sending > 15 min" in `/admin/digest` with a "mark as failed" button; log the provider message id. | M |
| BE-04 | Medium | No spend cap. Cost is only reported (`/admin/costs`). Defaults allow `BATCH_LIMIT` 25 per stage per hourly run on the strong model for write and fact-check, which is up to about 600 stories a day if feeds supply them. `.env.local` sets `BATCH_LIMIT=3`, which hides this locally. | `lib/config.ts` (`PIPELINE_DEFAULTS`); `app/admin/(protected)/costs/page.tsx`; no budget check in `lib/llm/index.ts` | Add a daily token/cost budget checked in `callAgent`; stop the stages and show a banner when hit. | M |
| BE-05 | Low | No lock against two runs of the same stage (cron plus the admin "Run next batch"). Status-guarded updates prevent double writes, but both runs can pay for the same LLM calls. | `lib/pipeline/classify.ts` (`updateItem ... .eq("status","new")`) | A short advisory lock or a `pipeline_runs` "running" row. | M |
| BE-06 | Low | Logging is `console.error` only; there is no structured log, alert or dashboard. A failing stage is visible only if someone opens the Pipeline tab (and that tab has no data until ADM-03 is fixed). | `lib/pipeline/stages.ts:112-120`; `lib/llm/index.ts:179` | Vercel log drain or Sentry; email/Slack on two consecutive failed runs. | M |
| BE-07 | Low | Live backlog: 63 raw items `new-relevant` waiting for the write stage, 9 drafts waiting for the fact-check, 3 rejected. The latest runs were this morning, so the pipeline works but is not keeping up at `BATCH_LIMIT=3`. | live status counts | Set `BATCH_LIMIT` deliberately for production and run the weekly batch. | S |

**OK:** retry/backoff and 429 handling per stage leave items queued instead of failing them (`lib/pipeline/chunks.ts`, `lib/llm/index.ts`); Unsplash 429 falls back to the department image; stages are idempotent (`status` guards, unique `raw_item_id`, `url`); digest sends are claimed atomically; the health endpoint is bearer-protected and returns counts only; time zones are consistent (digest week in Asia/Kolkata, crons in UTC, freshness in UTC).

**Important paths with no tests:** `proxy.ts`; all `app/**/actions.ts`; the cron route handlers and `health` route; the Supabase-backed stores (`lib/digest/store.ts`, `lib/submissions/store.ts`, `lib/submissions/admin.ts` including the real storage copy, `lib/admin/review-data.ts`); `runIngest` (`lib/pipeline/ingest.ts`: only its helpers are tested); real SMTP/Graph sends; every React component (`Dashboard`, `Globe`, `SubmitForm`, the admin boards); end-to-end flows (submit -> approve -> public -> digest). The in-memory and fake-store tests cover the rules, not the SQL they run against.

### Deployment readiness

| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| DEP-01 | High | `vercel.json` schedules five crons hourly. As far as I know the Hobby plan only allows daily crons and caps functions at 60 s; `/admin/review` declares `maxDuration = 300`. Check Vercel's current limits page; plan on Pro. | `vercel.json:3-9`; `app/admin/(protected)/review/page.tsx:41`; cron routes `maxDuration = 60` | Use Pro, or run the pipeline from another scheduler (GitHub Actions calling the cron routes with the bearer token) and lower the review page `maxDuration`. | S |
| DEP-02 | High | `SMTP_PASS` is read as empty. The value starts with `#` and is unquoted; Next's env loader treats it as a comment (loaded length 0, file length 14). The password also contains `$$`, which `dotenv-expand` can alter. Sending fails (`send_failed` in `digest_log`; the digest is stuck `approved`). | `.env.local:50`; checked with `@next/env` | Quote it: `SMTP_PASS='...'` (single quotes avoid `$` expansion), or use a password without `#`/`$`. On Vercel, paste the raw value in the dashboard. | S |
| DEP-03 | Medium | `.env.local` defines `ADMIN_EMAILS` twice (lines 22 and 42); the last wins, so the only admin is a personal Gmail address, not a company one. `SITE_URL` and `APP_URL` are `localhost`. `ALLOWED_EMAIL_DOMAINS` is unset. | `.env.local:22,42,44,48` | See the checklist below. | S |
| DEP-04 | Low | The production env is not validated at build or boot; `env()` throws on first use. A typo shows up as a 500 on the first request. | `lib/env.ts` (lazy parse) | Call `env()` from `instrumentation.ts` so a bad config fails the deploy. | S |

#### Production env checklist

| Variable | Production value / action |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the production project |
| `SUPABASE_SERVICE_ROLE_KEY` | server-only; never `NEXT_PUBLIC_`; rotate if exposed |
| `CRON_SECRET` | 32+ random characters; the same value in Vercel |
| `ADMIN_EMAILS` | one line, company addresses, each also invited in Supabase Auth |
| `ALLOWED_EMAIL_DOMAINS` | the company domain (SEC-06) |
| `SITE_URL` | the public https URL (links in the email); not localhost |
| `EMAIL_PROVIDER`, `MAIL_FROM`, `SMTP_*` or `MS_*` | quote `SMTP_PASS`; IT must enable SMTP AUTH on the mailbox |
| `LLM_PROVIDER` + its key, `UNSPLASH_ACCESS_KEY` | set; remove unused keys (`PEXELS_API_KEY`) |
| `BATCH_LIMIT` and the other volume settings | set on purpose (BE-04) |
| `APP_URL` | local only; do not set in production |

Cookies need no change (host-only cookies on the production domain, `Secure` on https). There is no CORS surface (no cross-origin API). In Supabase Auth set Site URL and redirect URLs to the production domain.

#### Data-protection note (what personal data is stored)

| Data | Where | Who can read it | Kept |
|---|---|---|---|
| Author first/last name, department | `articles` | public once published (it is the byline) | until the article is deleted |
| Author company email, email-verified flag, photo path | `article_submitters` | service role / admins only (anon verified denied) | forever today (SEC-13) |
| IP address | only as an HMAC-SHA256 hash (IPv6 reduced to /64) in `article_submitters.ip_hash`; never raw | service role only | forever today; needed for 24 h |
| Submitted photo | private bucket `submission-images`, EXIF/GPS stripped; public copy only after approval | admins (signed URL) | forever today |
| Admin emails | `review_log`, `digest_log`, `digests.approved_by`, Supabase Auth; **and currently `articles.review_note`** (SEC-01) | admins; review_note is public | forever |
| Digest recipient emails | `digest_recipients` | service role / admins | until removed |

Recommended: a privacy notice on `/submit`; delete `ip_hash` after 7 days; delete or anonymize the submitter email 90 days after the decision; a documented way to delete one person's data (their article, submitter row and photo). India's DPDP Act and the GDPR both expect purpose, retention and deletion to be stated.

#### Launch checklist

1. Fix Phase 1 below.
2. Run all three migrations in order on the production project; open `GET /api/cron/health` with the bearer token and confirm `ok: true`.
3. Run the two verification SQL queries (RLS and policies) and keep the output.
4. Disable sign-ups, invite the admins, enable MFA, set session limits.
5. Set the env checklist on Vercel (Pro plan), deploy, and call each cron route once by hand.
6. Send a digest to yourself, then to a small list; confirm one message per recipient batch and no addresses visible.
7. Submit a story from a company address and from an outside address (the second must be refused); approve it; check the byline, photo and that no email appears at `https://<project>.supabase.co/rest/v1/articles?select=*` with the anon key.
8. Confirm backups and take a manual dump.

---

## (c) Suggested fix order

### Phase 1: before anyone else uses it

| Order | ID | Action | Effort |
|---|---|---|---|
| 1 | SEC-01 | Stop writing the admin email into `review_note`; scrub the 2 existing rows | S |
| 2 | SEC-02 | Restrict anon to the public columns of `articles` (grants or a view) | M |
| 3 | SEC-03 | Turn off public sign-ups in Supabase | S |
| 4 | ADM-03 / DB-01 | Run the 2026-10-14 migration (restores the audit log and pipeline history); drop or document the 3 stray columns | S |
| 5 | SEC-06 | Set `ALLOWED_EMAIL_DOMAINS`; add a rate-limit rule on `POST /submit` | S |
| 6 | DEP-02 / DEP-03 | Quote `SMTP_PASS`; remove the duplicate `ADMIN_EMAILS` line and use company addresses | S |
| 7 | ADM-01 | Add a logout button | S |
| 8 | SEC-11 | Rotate the SMTP password (and service-role key if the transcript is retained) | S |

### Phase 2: before the company-wide launch

| ID | Action | Effort |
|---|---|---|
| DEP-01 | Move to Vercel Pro or an external scheduler | S |
| SEC-05 | Security headers and `poweredByHeader: false` | M |
| ADM-02 | MFA for admins, session limits, shorter cookie lifetime | M |
| SEC-13 | Privacy notice, retention jobs, deletion procedure | M |
| PERF-01, PERF-05 | Slim list query, cap and cache the homepage | M |
| PERF-02 | Cap DPR, offscreen glow, pause when off-screen | M |
| BE-01, BE-02, BE-03 | Ingest time budget, LLM timeouts, stuck-`sending` recovery | M |
| BE-04 | Daily spend cap | M |
| SEC-07 | Block private ranges and limit redirects in ingest | M |
| DB-02, DB-03, DB-04, DB-06 | FK indexes, retention, backups, placeholder sources | M |
| DEP-04 | Validate env at boot | S |
| Tests | Add tests for `proxy.ts`, the server actions, `runIngest`, the Supabase stores (against a local Postgres), and one end-to-end submit-to-publish test | L |

### Phase 3: nice to have

SEC-04 (policy listing as a post-deploy check), SEC-08, SEC-09, SEC-10, SEC-12, ADM-04, ADM-05, DB-05, PERF-03, PERF-04, BE-05, BE-06, BE-07, a skip link, CAPTCHA if `/submit` is abused.

## Addendum (2026-10-22): the Write feature and its attack surface

Block stories, images, likes and comments add the first places where a visitor's content is shown to other people and where cookies drive a change. This is the review of that surface (code and tests; it was not run against a real database).

| Surface | What can go wrong | What stands in the way | Where it is tested |
|---|---|---|---|
| `POST /api/write/submit` (public, multipart, up to 41 MB) | spam, large uploads, cross-site posts | Origin check, `Content-Length` limit before reading, a connection that already sent its daily limit is stopped before the body is read, then the old limits (3 per IP, 5 per email a day, duplicate titles), honeypot, optional Turnstile | `app/api/write/route.test.ts`, `lib/stories/submit.test.ts` |
| Block JSON | stored XSS, huge documents, unknown types | one strict zod schema on the server (types, counts, lengths, `http(s)` links only, unknown fields dropped), React elements only, no HTML parsing anywhere, DB check on size and shape | `lib/stories/blocks.test.ts`, `components/story/story.test.ts` (hostile story rendered) |
| Images | SVG with script, polyglot files, EXIF location, decompression bombs, public exposure before review | type from the bytes, 5 MB, pixel limit, re-encode to WebP with metadata dropped, private bucket until approval, copy on approve and rewrite of the block (the private path leaves the public columns), failure keeps the story pending | `lib/stories/submit.test.ts`, `lib/stories/publish.test.ts` |
| Code blocks | trojan-source (hidden direction marks), script in code | hidden and control characters stripped (tabs kept), shown as text, highlighter produces `<span class="hljs-...">` elements only | `lib/stories/blocks.test.ts`, `components/story/story.test.ts` |
| Reader sign-in (one-time email code) | enumerating addresses, guessing codes, mail bombing others, code reuse | any company address gets a code with no "exists" signal, 5 codes an hour per address and 20 per connection, code hashed and bound to the address, 10 minutes, one use, five tries counted atomically in the database before comparing | `lib/reader/reader.test.ts` |
| Session cookie | forgery, theft by script, cross-site use | HMAC-signed, HttpOnly, SameSite=Lax, Secure on https, 14 days; changing routes require a same-origin request and JSON | `lib/reader/reader.test.ts`, `app/api/reader/routes.test.ts` |
| Likes and comments | spam, duplicate comments, impersonation, leaking who liked or who wrote | signed-in only, rate limits (likes 30/h and 200/day, comments 5/h and 20/day), duplicates refused, control characters stripped, `user_key` and `article_likes` never readable by the public key (column grants, view of counts), hidden comments invisible by row-level security | `lib/reader/reader.test.ts`, `lib/stories/story-sql.test.ts`, `lib/admin/rls-check.test.ts` |
| Moderation | a non-admin hiding comments | admin check first, every change in `comment_log` | `lib/stories/moderation.test.ts`, `app/admin/non-admin.test.ts` |
| Personal data | an author's name shown without consent, data left after a request | name consent (public byline "Newsroom contributor" otherwise), real name and images cleared by retention, erasure tool also deletes a person's likes, comments and sign-in codes | `lib/stories/submit.test.ts`, `lib/erasure/erase.test.ts` |
| Content-Security-Policy | the new browser code needing `'unsafe-eval'` or inline scripts | zod runs `jitless` in the form (its default uses `new Function`), no inline styles or `dangerouslySetInnerHTML` in the new components (tests scan them), the Playwright run fails on any violation | `components/write/csp-safe-zod.test.ts`, `components/story/story.test.ts`, `npm run e2e` |

Residual risks, stated plainly: the one-time code proves control of a mailbox, not who a person is, and a person with two company addresses has two identities; a session cannot be revoked before it expires except by rotating the secret; a Write story's text is not edited by the editor (reject with a reason instead); the comment text of someone who is erased is deleted, not anonymized; the keyed hash changes if `SUBMISSION_HASH_SALT` / `CRON_SECRET` is rotated, which ends every session and lets people like a story again; hosts with a small request limit (Vercel: about 4.5 MB) refuse a story whose images are large.

### Addendum (2026-10-23): AI-written blocks blogs

The write stage now asks the model for structured blocks (Software Development and AI & Technology only). The model's output is untrusted content that ends up on the public site, so it is treated like a visitor's:

| Surface | What can go wrong | What stands in the way | Where it is tested |
|---|---|---|---|
| Model output stored as a story | malformed or hostile blocks, HTML, scripts, links to anywhere | the story schema plus the blog rules inside the retry loop (no HTML, markdown or URL in reading text; only six block types; no address or id field in the schema the model sees); the server adds ids and the one source link itself; the assembled story is validated again before it is returned; failure after one retry marks the item failed, nothing is stored | `lib/pipeline/blog.test.ts` |
| Code written by the model | invented APIs, versions, broken or unsafe examples | limited to 2 short blocks; JSON/JS/TS parsed and Python structure-checked, never executed; versions and packages the source does not mention are flagged; every finding goes to the admin note; code is drawn as text | `lib/pipeline/code-check.test.ts`, `components/story/story.test.ts` |
| Pictures | a wrong or repeated stock photo, missing credit | a search per phrase, duplicates and misses dropped, credit and profile link stored on the block and shown, only `images.unsplash.com` addresses are drawn | `lib/pipeline/image-blocks.test.ts` |
| Facts | claims the source does not make | the fact-check runs over the text blocks with the same strictness; an unplaced picture is dropped at approval; the editor reads the whole story in the review card | `lib/pipeline/factcheck-blocks.test.ts` |
| Cost | a long call that cannot finish in the route's time | a blog only starts when a full LLM timeout fits in the stage's remaining budget; daily cap and 429 handling as before; tokens logged for every response | `lib/pipeline/blog.test.ts` |

Residual risks: the code check cannot prove that code is correct or safe (Python is only structure-checked); the fact-check compares the draft with one source and cannot see what the model left out; the reading text can still contain a plausible falsehood that the fact-check misses, which is why every blog is read by an editor before it is published.