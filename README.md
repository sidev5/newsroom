# AI Newsroom

Internal news site for the EV, Batteries, Defence, Software Development and Sales & Marketing departments. A cron pipeline collects news from RSS feeds, keeps only company-relevant items, has Claude write short sourced articles and fact-check them, and publishes only after a human approves each one.

Pipeline: **ingest → classify → write → image → fact-check → human review → published.** Each stage is a cron route that processes up to `BATCH_LIMIT` items per run, so cost and runtime stay bounded.

## Setup

### 1. Install

```bash
npm install
cp .env.example .env.local   # PowerShell: Copy-Item .env.example .env.local
```

Fill in `.env.local`. **Never commit it.** `.gitignore` excludes every `.env*` file except `.env.example`.

`SUPABASE_SERVICE_ROLE_KEY` bypasses Row Level Security. Only server code reads it (`lib/supabase/admin.ts` imports `server-only`), and it must never get a `NEXT_PUBLIC_` prefix.

### 2. Create the database

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** and run `supabase/schema.sql`, then `supabase/seed.sql`. On a new project that is all: `schema.sql` already contains every migration, and it also creates the two storage buckets. Both files can be re-run safely. `supabase/migrations/` is only for a database built before a given change; the order is under **Deploying → 1. The database**.
3. `seed.sql` creates the departments, eight working World feeds and ten **inactive** placeholder feeds (`https://example.com/replace-me/...`) for EV, Batteries, Defence, Software and Sales & Marketing; `schema.sql` adds six working AI & Technology feeds. Those five company departments get no news until you give them real feeds: replace a placeholder's URL and set `active = true` (Table Editor), or insert new rows (see **Adding sources**).

RLS is enabled on every table:

| Table | Anon / logged-in users | Service role (server) |
|---|---|---|
| `articles` | read rows with `status = 'published'` | full access |
| `departments` | read (needed for tags and filters) | full access |
| `sources`, `raw_items`, `agent_runs` | no access | full access |
| `article_submitters` (author email, IP hash) | **no access, ever** (RLS on, no policy, privileges revoked) | full access |

### 3. Lock down Supabase Auth (important)

Admins sign in with email and password, so:

1. **Authentication → Sign In / Providers → Email:** turn **off** "Allow new users to sign up".
2. **Authentication → Users → Invite user:** invite each admin by email.
3. Add the same emails to `ADMIN_EMAILS` in `.env.local` (and in Vercel later). A user who is not on that list can't open `/admin`, even with a valid login.

### 4. Check the setup

```bash
npm test             # unit tests
npm run e2e          # browser smoke test (see below); needs Chrome, takes a few minutes
npm run dev          # in one terminal
npm run stage -- health   # in another
```

`health` should print `200` with row counts: 5 departments and 10 sources after seeding. A `401` means `CRON_SECRET` is missing or the header is wrong. An `Invalid environment` error lists the variables that need fixing.

`npm run e2e` builds the production app against a small local stand-in for Supabase (`e2e/mock-supabase.mjs`, nothing real is touched) and drives it with Chrome: an employee writes a story with blocks (adds, moves and deletes blocks, previews it, sends it), an editor signs in and approves it, it appears on the homepage and in the slide-in reader with its code highlighted, and the digest preview shows it. It also fails on any Content-Security-Policy violation on those pages. It deletes `.next` first (a reused build would serve the cached pages of the previous run). Chrome is found automatically; set `E2E_CHROME` to its path if it is not. The mock understands only the requests this app makes, so it proves the app's wiring, not Supabase's behaviour (RLS and the SQL are checked by `npm run check-rls` against the real project).

## Configuration

Copy `.env.example` to `.env.local` locally; on Vercel set the same names under Project Settings → Environment Variables.

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | required | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | required | Anon/publishable key (browser-safe; RLS limits it) |
| `SUPABASE_SERVICE_ROLE_KEY` | required | **Server only.** Bypasses RLS. Used by cron routes and by admin actions after the admin check |
| `CRON_SECRET` | required | 16+ random characters. Cron routes reject any request without `Authorization: Bearer <secret>` |
| `ADMIN_EMAILS` | empty | Comma-separated emails allowed to use `/admin` (must also exist as Supabase Auth users) |
| `GEMINI_API_KEY` | – | Needed when `LLM_PROVIDER=gemini` |
| `ANTHROPIC_API_KEY` | – | Needed when `LLM_PROVIDER=anthropic` |
| `IMAGE_PROVIDER` | `unsplash` | Only `unsplash` exists |
| `UNSPLASH_ACCESS_KEY` | – | Needed by the image stage |
| `APP_URL` | `http://localhost:3000` | Local dev only, used by `npm run stage` |
| `MAX_ITEM_AGE_DAYS` | `3` | Classify skips items whose source was published longer ago than this (`too_old`) |
| `LLM_PROVIDER` | `gemini` | `gemini` or `anthropic`; needs `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` |
| `BATCH_LIMIT` | 25 | Max items one stage processes per run, across its chunks (defaults live in `PIPELINE_DEFAULTS` in `lib/config.ts`) |
| `MAX_ITEMS_PER_FEED` | 15 | Max new items ingest takes from one feed per run, newest first |
| `STAGE_CHUNK_SIZE` | 5 | Items per chunk; a stage works through its queue chunk by chunk |
| `STAGE_DELAY_MS` | 1500 | Pause between chunks (rate limits) |
| `STAGE_TIME_BUDGET_MS` | 50000 | A stage (ingest included) stops starting items after this long, to end before `maxDuration` |
| `LLM_TIMEOUT_MS` | 45000 | One LLM call is given up on after this long and its item stays queued (5000 to 280000) |
| `DAILY_BUDGET_USD` | 2 | Daily cap on LLM spend (Asia/Kolkata day), priced with `MODEL_PRICES_USD_PER_MTOK`. At the cap the stages stop and items stay queued; an admin can raise today's limit |
| `RELEVANCE_THRESHOLD` | 7 | Minimum classifier score (0–10) to keep an item |
| `KEYWORD_PRECHECK` | true | Skip items matching no department keyword before calling the LLM |
| `MIN_SOURCE_WORDS` | 120 | Shorter sources are skipped at the write stage |
| `FETCH_USER_AGENT` | `AINewsroomBot/1.0` | Identifiable UA for RSS and page fetches |
| `FETCH_TIMEOUT_MS` | 10000 | Per-request fetch timeout |
| `ADMIN_IDLE_MINUTES` | 30 | An admin is signed out after this many minutes without an admin request |
| `ADMIN_SESSION_HOURS` | 8 | An admin is signed out this many hours after signing in, whatever they are doing |
| `ADMIN_SESSION_SECRET` | `CRON_SECRET` | Secret (16+ characters) that signs the admin activity cookie |
| `ALLOWED_EMAIL_DOMAINS` | empty | Company email domains allowed on `/submit`, comma-separated. Empty accepts any email but flags it unverified in the admin queue. A malformed entry is an error, not an empty list |
| `SUBMISSION_HASH_SALT` | `CRON_SECRET` | Secret for hashing visitors' IPs (16+ characters); also keys the hash that the "Delete a person's data" log keeps instead of an email |
| `PRIVACY_CONTACT` | empty | Address shown on `/submit` for requests to see or delete one's data. Required by `check-env --production` |
| `SUBMITTER_IP_RETENTION_DAYS` | 7 | The stored hash of a submitter's IP is deleted after this many days |
| `SUBMITTER_EMAIL_RETENTION_DAYS` | 90 | A submitter's email is replaced by an anonymous placeholder this many days after the story was published or rejected (and the private copy of their photo is deleted) |
| `CSP_MODE` | `report-only` | `report-only` or `enforce`: how the Content-Security-Policy is sent. Read at build time: change it, then deploy again |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` | empty | Cloudflare Turnstile on `/submit`: set both to turn it on, neither to leave it off |

**Quoting rule for `.env.local`:** a value that contains `#`, `$`, spaces or quotes must be in single quotes, for example `SMTP_PASS='p#ss$word'`. Unquoted, `#` starts a comment (the value silently becomes empty or truncated) and `$` is expanded as a variable. In Vercel's dashboard paste the value as it is, without quotes. Every key must appear once: the loader keeps the last one without saying so.

**Startup check:** `instrumentation.ts` validates the environment when the server starts and refuses to boot, naming every problem, if a required setting is missing or invalid, or if `SMTP_PASS` is empty while `EMAIL_PROVIDER=smtp` (the same for the Graph settings). Warnings (empty `ADMIN_EMAILS`, empty `ALLOWED_EMAIL_DOMAINS`, `SITE_URL` still on localhost in production) are printed and the app starts. `npm run check-env` runs the same check from the terminal and also reads `.env.local` to warn about a key defined twice. `next build` itself does not need secrets, so it is not checked.

Model names live in `lib/config.ts`.

## LLM providers

Set `LLM_PROVIDER` to switch every agent between Gemini and Anthropic. Nothing else changes: the stages call `callAgent()` (`lib/llm/index.ts`), which behaves the same on both providers.

| Agent | Tier | Gemini | Anthropic |
|---|---|---|---|
| classify | fast | `gemini-3.5-flash-lite` | `claude-haiku-4-5-20251001` |
| write | strong | `gemini-3.6-flash` | `claude-sonnet-5-5` (effort `medium`) |
| factcheck | strong | `gemini-3.6-flash` | `claude-sonnet-5-5` (effort `high`) |

Google lists no stable Pro model at the moment. To try the preview one, set `LLM_MODELS.gemini.strong` to `gemini-3.1-pro-preview` in `lib/config.ts`.

### Write and fact-check on a free tier (Groq)

Write and fact-check can each run on a different provider from classify. Classify always uses `LLM_PROVIDER`, which accepts only `gemini` or `anthropic`.

```
WRITE_LLM_PROVIDER=groq
FACTCHECK_LLM_PROVIDER=groq
GROQ_API_KEY=gsk_...
GROQ_MODEL=openai/gpt-oss-120b
```

If either setting is empty, that stage uses `LLM_PROVIDER`. `GROQ_MODEL` has no default. Take the id exactly as Groq's [model list](https://console.groq.com/docs/models) spells it. `openai/gpt-oss-120b` was a production model with structured outputs when this was written (2026-10-29). Groq's preview models can be removed at short notice.

How it works (`lib/llm/providers/openai-compatible.ts`, plain `fetch` to `<baseUrl>/chat/completions`):

- **JSON.** Models listed under Structured Outputs on Groq's docs (`jsonSchemaModels` in `lib/config.ts`) get `response_format: json_schema` in best-effort mode. Strict mode would require every field, and the write schema has an optional one. Other models get `json_object`, with the schema added to the system message. Either way `callAgent` validates the reply with the same zod schema and retries once with the error. Groq's `400 json_validate_failed` counts as invalid output (one retry, then the item is marked `failed`), not as a provider error.
- **Limits.** Requests are spaced `60000 / requestsPerMinute` ms apart: 2 s for Groq's 30 per minute. A run handles at most `BATCH_LIMIT` items, as for every provider. `max_completion_tokens` is capped at `maxOutputTokens` (6000), because free tiers count tokens per minute. A 429 waits for Groq's `retry-after` (up to 30 s) and retries 3 times. 5xx errors and network failures get the usual backoff. If they persist, the stage stops with the items still queued, and the HTTP status and Groq's message (keys removed) appear in `stoppedError` and `pipeline_runs.error`.
- **Cost.** Runs are logged in `agent_runs` as `groq/<model>` and priced at $0 (`freeTier`), so they do not count toward `DAILY_BUDGET_USD`.
- **Check your account's limits** on Groq's Limits page (console.groq.com/settings/limits). The public docs list the Developer plan's limits, not the free tier's. If the per-minute token limit is low, lower `STAGE_CHUNK_SIZE` or `BATCH_LIMIT`.

**Adding Cerebras (or another OpenAI-compatible API)** takes one entry in `OPENAI_COMPATIBLE_PROVIDERS` in `lib/config.ts` (base URL, the names of its key and model variables, requests per minute, output cap, models with JSON-schema support, free or not) plus those two variables in the environment. `WRITE_LLM_PROVIDER`, `check-env`, the price table and key redaction pick it up from there. Check the provider's own docs for the limit and the model ids first.

What `callAgent` does on every call:

1. **JSON output.** Gemini gets `responseMimeType: "application/json"` plus a JSON Schema generated from the agent's zod schema. Anthropic gets structured outputs (`output_config.format`) from the same zod schema.
2. **Validation.** The reply is parsed and validated with zod. If it fails, the call is retried **once**, with the validation error added to the prompt. Two failures return `invalid_output`, and the stage marks the item `failed`.
3. **Backoff.** On a 429, the call waits for the provider's suggested delay (Anthropic `retry-after`, Gemini `retryDelay`), or 2s/4s/8s plus jitter, capped at 30s. It tries up to 3 more times. 5xx errors, timeouts and network errors get the same backoff. Bad requests and bad keys are not retried. Both SDKs' built-in retries are turned off so the two providers behave the same.
4. **Unprocessed, not failed.** If 429s persist, the call returns `rate_limited`. For a 5xx after retries or a config error it returns `provider_error`. In both cases the stage **leaves the item's status unchanged**, so the next run retries it, and stops the rest of the batch. The reason is reported as `stoppedError` in the stage's answer (printed on its own line by `npm run stage`), kept in `pipeline_runs.error` of the run (which still counts as ok, so no failure alert) and shown on the Pipeline tab: provider, model, attempt, HTTP status and the provider's message, for example `gemini gemini-3.6-flash, attempt 4 of 4: HTTP 503 UNAVAILABLE: This model is currently experiencing high demand.` API keys are removed from it.
5. **Logging.** Every response received writes an `agent_runs` row with the agent, the model that actually served it, the article or raw item id, and input/output tokens, retries included. Calls that return no response (a 429) have no token usage and aren't logged.

On Anthropic's strong tier, server-side refusal fallback is on (`fallbacks: "default"`): if Sonnet declines a request on safety grounds, the API re-runs it on a fallback model within the same call, and `agent_runs.model` records which model answered. To turn it off, remove `refusalFallback` in `lib/llm/index.ts`.

## Cron routes

Every route under `app/api/cron/` rejects any request without `Authorization: Bearer ${CRON_SECRET}`, returning `401`. The GitHub Actions workflows below send this header from the repository secret `CRON_SECRET`.

### Schedule (`.github/workflows/pipeline.yml` and `digest.yml`)

The app is set up for the Vercel **Hobby** plan, which runs crons at most once a day: `vercel.json` has no crons, and GitHub Actions calls the routes instead (`docs/DEPLOY_VERCEL.md`).

| Stage | Route | Schedule (UTC) |
|---|---|---|
| ingest | `/api/cron/ingest` | `0 5,17 * * *` (twice a day) |
| classify | `/api/cron/classify` | `30 5,17 * * *` (twice a day) |
| write | `/api/cron/write` | `0 2,6,10,14,18,22 * * *` (every 4 hours) |
| image | `/api/cron/image` | `30 2,6,10,14,18,22 * * *` (every 4 hours) |
| fact-check | `/api/cron/factcheck` | `0 3,7,11,15,19,23 * * *` (every 4 hours) |
| cleanup (retention) | `/api/cron/cleanup?apply=true` | `15 1 * * 0` (Sundays; see **Reliability**) |
| digest draft | `/api/cron/digest-draft` | `0 3 * * 1` (Mondays, `digest.yml`) |
| digest send | `/api/cron/digest-send` | `30 5 * * 1` (Mondays, later, `digest.yml`) |

The offsets give each stage time to finish before the next one starts: write, image and fact-check each run half an hour to an hour after the stage before. Each call handles what fits in one run (`BATCH_LIMIT` items per chunk, until `STAGE_TIME_BUDGET_MS`), so a big queue takes several slots. Adjust the schedules to taste; the setup steps and the Vercel limits are in **Deploying** below. Every route sets `maxDuration = 60` seconds and the stages end themselves at `STAGE_TIME_BUDGET_MS`, so raising `BATCH_LIMIT` a lot only makes a run stop earlier and leave items for the next one.

### Running a stage by hand

```bash
npm run dev                       # terminal 1
npm run stage -- ingest           # terminal 2: ingest | classify | write | image | factcheck | health
```

`npm run stage` reads `.env.local`, sends the bearer token, prints the JSON result, and refuses to run against anything but `localhost`. Run the stages in pipeline order. Each only touches items in the status it consumes: classify takes `new`, write takes `new-relevant`, image takes drafts with no image, and fact-check takes drafts with an image.


**Trimming a long write queue (one-off).** `npm run stage -- trim-queue --keep 30` keeps the best 30 raw items waiting to be written (status `new-relevant`: highest `relevance_score` first, an item with no score last, equal scores newest first) and sets the rest to `skipped` with `classify_reason = 'trimmed_backlog'`. It is a **dry run** unless you add `--apply`, and prints the counts before and after (for a dry run, what they would be). Nothing is deleted: the items are on the Skipped tab of `/admin/review`, where *Mark relevant* puts one back. It talks to the database in `.env.local` directly (it prints which one first), only touches items that are still `new-relevant`, and refuses to apply while the write or classify stage is running. Code: `lib/maintenance/trim-queue.ts`, `scripts/trim-queue.ts`.
### Status flow

`raw_items`: `new` → `new-relevant` or `skipped` (or `failed`) → `written`. `articles`: `draft` → `pending_review` or `rejected` (fact-check) → `published` or `rejected` (human).

## Pipeline

### 1. Ingest (`/api/cron/ingest`, no LLM)

For each active source:

1. Fetch the feed (RSS 2.0, RSS 1.0/RDF or Atom) using `FETCH_USER_AGENT`, a `FETCH_TIMEOUT_MS` timeout and a 3 MB size cap. Every URL, the feed's, each page's and each redirect target, is checked first (see **Reliability**: no private or internal addresses, http(s) on ports 80 and 443 only, at most 3 redirects).
2. Normalise each link (drops `#fragments` and `utm_*`/`fbclid`/`gclid` parameters), then skip URLs already in `raw_items` or repeated within the feed.
3. Take at most `BATCH_LIMIT` new items **per source**. The rest are counted as `deferred` and picked up on the next run.
4. For each new item, check the site's `robots.txt`. If our bot is allowed, fetch the page and extract the main text with Readability. If robots.txt disallows the page, or it can't be reached (5xx/network error), skip the page fetch and keep only the RSS summary. A missing robots.txt (4xx) counts as allowed.
5. Store the text with HTML stripped: `content` (RSS summary, capped at 5k chars) and `full_text` (page text, capped at 20k chars). **`full_text` is for internal use by the writer and fact-checker only and is never displayed.**

A failing feed or page never stops the run: errors are caught per source and per item. The response reports:

```json
{ "totals": { "fetched": 40, "inserted": 12, "duplicates": 25, "failed": 1, "deferred": 3, "fullText": 9 },
  "sources": [ { "source": "EV source 1", "fetched": 20, "inserted": 3, "...": "..." },
               { "source": "Defence source 2", "failed": 1, "error": "feed: HTTP 404 for https://..." } ] }
```

`failed` counts failed feeds plus failed item inserts. A page whose text couldn't be fetched isn't a failure: the item is stored with only its summary, and `fullText` shows how many items got page text.

### 2. Classify (`/api/cron/classify`, fast model)

Takes up to `BATCH_LIMIT` items with `status='new'` (oldest first):

1. If the source was published more than `MAX_ITEM_AGE_DAYS` ago: `status='skipped'`, `classify_reason='too_old'`, no LLM call. Items with no date are not skipped.
2. If `KEYWORD_PRECHECK=true`, match each department's keywords (whole words, case-insensitive) against title + content. No match: `status='skipped'`, `classify_reason='no_keyword_match'`, no LLM call.
3. Otherwise call the fast model with the title, the first 500 characters of content, the department list (name + description) and the keywords that matched. The article text sits inside `<article>` tags and the model is told it is untrusted data. It returns `{department, relevance (0-10), reason}`.
4. `relevance >= RELEVANCE_THRESHOLD` sets `status='new-relevant'`, `department_id` and `relevance_score`. Otherwise `status='skipped'` with the model's reason.
5. Invalid JSON twice in a row sets `status='failed'`. A rate limit or provider outage leaves the item as `new` and stops the batch.

Response: `{ "processed": 3, "relevant": 1, "skipped": 2, "failed": 0, "unprocessed": 0, "stopped": null }`. Every attempt, including the retry, is logged to `agent_runs` with the model and `raw_item_id`.

### 3. Write (`/api/cron/write`, strong model)

Takes up to `BATCH_LIMIT` items with `status='new-relevant'` (oldest first):

1. If the source text (`full_text`, else the RSS `content`) has fewer than `MIN_SOURCE_WORDS` words: `status='skipped'`, `classify_reason='source_too_short'`, no LLM call.
2. Otherwise call the strong model. The source sits inside `<article>` tags and is treated as untrusted data. The model may use only facts from the source, and returns `{headline, body (150-250 words), image_query, image_alt}`.
3. The result is saved as an `articles` row with `status='draft'`, `raw_item_id`, `source_urls` (the item's URL), `slug` (headline plus 8 characters of the item id) and `department_id`. The raw item becomes `written`.
4. Invalid JSON, or a body outside 150-250 words, twice in a row sets the raw item to `failed`. A rate limit or provider outage leaves it as `new-relevant` and stops the batch.

Response: `{ "processed": 3, "written": 2, "skipped": 1, "failed": 0, "unprocessed": 0, "stopped": null }`. The prompt forbids invented facts, but nothing checks that mechanically; the fact-check stage does that.

#### AI-written blogs (Software Development and AI & Technology)

For an item filed under **Software Development** (`software`) or **AI & Technology** (`ai-technology`; the slugs are `BLOG_DEPARTMENT_SLUGS` in `lib/config.ts`) the write stage makes a longer **blocks story** instead of the short article: `body_format = 'blocks'`, `origin = 'ai'`, the same JSON shape as a story written by hand (`lib/stories/blocks.ts`). Every other department, and any item in those two whose source has fewer than `BLOG_LIMITS.MIN_SOURCE_WORDS` (350) words (600 words from a thin source would have to be padded with things it does not say), keeps the plain format above, unchanged. Code: `lib/pipeline/blog.ts`.

- **What the model returns** (structured output, as for the other agents: the schema is turned into each provider's JSON-schema mode; it contains no transforms and no URL or id field): `title`, `summary`, `country_code`, a cover `image_query` and `image_alt`, and `blocks` of type paragraph, heading (h2/h3), code (language from the 12 allowed, optional file name), list, quote and image (a **search phrase**, caption and alt text; no address). Ids are made by the server (`b1`, `b2`, ...).
- **Validation, then storage:** the model's answer goes through the story schema that stands behind every Write story, plus the rules for a blog: first block a paragraph, at least 2 headings, 600-1200 words of reading text (paragraphs, headings, lists, quotes; code and images do not count) with a 10% tolerance so a near miss does not use up the retry, at most 2 code blocks of at most 30 lines and 1500 characters, at most 3 images, and **no HTML, markdown or URL** in any reading text. Failures go back to the model once, with the list of what was wrong (`callAgent`'s existing retry); a second failure marks the raw item `failed` with the reason (`write_invalid_output: ...`). The assembled story is validated once more before it is returned, so nothing unvalidated is ever stored.
- **Prompt rules** (`BLOG_SYSTEM`): original words, never copied text or code; only what the source states (no invented API names, versions, numbers or claims; thin source, fewer sections); status claims tied to the source date; 600-1200 words; at most 2 short, self-contained, runnable code blocks, and **leave the code out when unsure**; at most 3 generic image phrases; plain text only; the source is untrusted data.
- **Sources:** the server appends a "Sources" heading and a link block built from the item's own URL (the model never writes a link). `source_urls` is set as for any article.
- **Code checks** (`lib/pipeline/code-check.ts`, nothing is ever run): JSON is parsed; JavaScript and TypeScript are parsed with `@babel/parser`; Python gets a **structure check only** (strings, brackets, indentation: there is no Python parser here, and the message says so); other languages are not checked. A second check flags version numbers and packages (`import`/`require`) that the source does not mention. Problems are **not** blocking: they are written into the admin-only `articles.review_note` ("Code check: code block 2 (Python) ..."), shown in amber on the review card. No migration is needed for this.
- **Pictures:** the image stage still sets the cover (department default if nothing is found). It also searches the stock-photo service for each picture block's phrase and stores `src`, the photographer and the profile link (with the utm parameters) on the block, shown as "Photo by <name> on Unsplash" under the picture. A phrase with no result, or one that finds a photo already used in the story, drops its block. If Unsplash answers 429 the story stays queued and is retried next run (plain articles still take the default). Each blog costs up to 4 searches (and the download-tracking calls): mind the hourly limit of your Unsplash app.
- **Fact-check:** the same stage runs over `articles.body`, which for a blog is the plain text of its reading blocks (no code, no pictures, no sources section), with a note in the prompt that code and images were removed. The result is stored as before.
- **Review:** the card says **AI-written**, shows the story as readers will see it (read-only, pictures and credits included), the source link and date, the fact-check result and any code warnings. Approve and Save change the headline only. Approving drops a picture that was never placed.
- **Reader:** an AI blog has its cover photo (with credit) above its blocks, the source note below, a reading time, and **no likes or comments** (those are for stories written by employees).
- **Cost and limits:** the stage is limited by `BATCH_LIMIT` and `DAILY_BUDGET_USD` as before; a 429 or the daily cap leaves items queued; every response (retries included) is an `agent_runs` row (agent `write`) with its token counts. A blog is one long call, so it only starts when at least `LLM_TIMEOUT_MS` (45 s) of the stage's time budget is left: expect about **one blog per cron run** (the cron routes end at 60 s); run the stage again, or use **Run next batch**, for more. If `articles.body_blocks` does not exist yet (`2026-10-22_story_blocks.sql` not run) the article is saved as plain text and the log says so.
### Freshness

- Ingest stores the feed's date (RSS `pubDate`, `dc:date`, Atom `published`/`updated`) as `raw_items.source_published_at`. Missing, invalid or far-future dates are stored as null. The write stage copies it to `articles.source_published_at`.
- The writer is given the source date and must tie any claim about current status to it ("as of <date>", "at the time of publication"). It must not say something "remains" or "still" holds unless the source says so.
- `lib/pipeline/freshness.ts` has `sourceAttribution()` ("Based on a source published 10 October 2026", or "publication date unknown") for the article page and review screen, to show next to the link in `articles.source_urls`, and `FACTCHECK_FRESHNESS_RULES` for the fact-check prompt. Those two screens and the fact-check stage don't exist yet.
- Existing databases need `alter table ... add column source_published_at` (included at the top of the relevant sections in `supabase/schema.sql`; re-run the file).

### 4. Image (`/api/cron/image`, no LLM)

Takes up to `BATCH_LIMIT` articles with `status='draft'` and no `image_url` (oldest first). Set `IMAGE_PROVIDER=unsplash` and `UNSPLASH_ACCESS_KEY`.

1. Search Unsplash with the article's `image_query` (`orientation=landscape`, top result only).
2. Store the image URL exactly as the API returns it (hotlinked, never downloaded or re-hosted) in `image_url`, the photographer's name in `image_credit`, and their Unsplash profile link in `image_credit_url`. Links carry `utm_source=ai_newsroom&utm_medium=referral` (set in `IMAGE_UTM` in `lib/config.ts`; change it to your app's name).
3. Call the photo's `download_location` endpoint, as the Unsplash guidelines require when a photo is used. If that call fails the photo is still used.
4. If nothing is found, or the API errors or returns 429, or there is no `image_query`, use the department's default SVG from `public/images/defaults/` (`default.svg` if the department has none) and leave `image_credit` null. After a 429 the rest of the batch goes straight to defaults.

One article failing never stops the run. Response: `{ "processed": 3, "found": 2, "fallback": 1, "failed": 0, "deferred": 0, "blockImages": { "placed": 0, "dropped": 0 } }`. `failed` counts articles whose result could not be saved; they are retried next run. `deferred` counts AI-written blog stories left for the next run because Unsplash rate-limited the search for their pictures; `blockImages` counts the pictures of blogs that were placed or dropped (see AI-written blogs above).

Show the credit with `<PhotoCredit credit={...} creditUrl={...} />` (`components/PhotoCredit.tsx`): "Photo by <name> on Unsplash", both linked. It renders nothing for default images and only links to unsplash.com. The article page and cards don't exist yet, so nothing renders it. Unsplash images are served from `images.unsplash.com`, which is allowed in `next.config.ts`.

Another provider is one module in `lib/images/` that implements `searchImage(query) -> {url, credit, creditUrl} | null`, plus a case in `getImageProvider()`.

### 5. Fact-check (`/api/cron/factcheck`, strong model)

Takes up to `BATCH_LIMIT` articles with `status='draft'` and an `image_url` (oldest first) and compares each with its raw item's source text (`full_text`, else the RSS `content`).

1. The model returns `{findings: [{severity, issue}]}`. It flags any claim not directly stated in the source, any number, date, timing, name, place or quote that isn't in the source, quotation marks around words the source doesn't contain, any claim of current status without a date, and any generalisation from one market or case to another (`lib/pipeline/freshness.ts` holds the freshness rules). Each finding is `major` (something the source doesn't support; when in doubt, major) or `minor` (the same fact in other words, e.g. "plain-text" for "TXT").
2. No major findings: `status='pending_review'`. Minor findings are stored in `fact_check_notes` as `- Minor: ...` lines and shown on the review card as a warning; with none, the notes are empty.
3. Major findings on a plain article: one repair. The writer (`WRITE_LLM_PROVIDER`) gets the source, the draft and only the major findings, and fixes or removes just those (the body may shrink to 90 words). The repaired draft is checked again: no major findings → `pending_review` with the repaired headline, body and summary; still major → `rejected` with the repaired text and the second check's findings. If the writer can't produce a valid repair, or the second check gives no valid answer, the original draft is rejected with the first findings. A blocks story (blog) is not repaired: major findings reject it.
4. Rejected notes list every finding, major first: `- Major: ...`, `- Minor: ...`.
5. Invalid JSON twice: `status='rejected'`, note `fact-check could not complete`. If the raw item has been deleted or has no text, the draft is rejected with `fact-check could not complete: source text unavailable`, without an LLM call.
6. A rate limit or provider outage (in the check, the repair or the second check) leaves the draft as `draft`, unchanged, and stops the batch.

The source and the draft are sent inside `<source>` and `<draft>` tags as untrusted data (the repair adds `<problems>`). Response: `{ "processed": 3, "passed": 1, "rejected": 2, "repaired": 1, "unprocessed": 0, "stopped": null }`; `repaired` counts drafts that went through the repair, and they are also counted in `passed` or `rejected`.

## Admin

**Sessions.** Signing in happens on the server, so the session cookies are `HttpOnly`, `SameSite=Lax`, `Secure` on https and live at most `ADMIN_SESSION_HOURS` (the library's own default would be 400 days). A signed activity cookie records when the admin signed in and when they last used an admin page: `proxy.ts` refreshes it on every admin request and signs the admin out, with a redirect to `/admin/login?reason=expired`, after `ADMIN_IDLE_MINUTES` of inactivity (default 30) or `ADMIN_SESSION_HOURS` in total (default 8). `currentAdminEmail()` checks the same marker again inside every page and action, and an action that fails with "Not authorised" also redirects to the login page. **Sign out** is in the admin nav. Sessions that started before this was deployed have no marker and are asked to sign in once.

**Two-factor sign-in (optional).** `/admin/security` lets an admin enrol an authenticator app (TOTP). It is not required yet; the admin pages show a note while no verified factor exists.

**Banners.** After an action the URL carries a short code (`?notice=published`, `?error=not_pending`, plus a few counts), never free text. The wording is fixed in `lib/admin/messages.ts`; details of a failure go to the server log.

Sign in at `/admin/login` with an invited Supabase Auth user whose email is in `ADMIN_EMAILS`. `proxy.ts` sends signed-out visitors to the login page and keeps the session fresh. The admin check itself runs in the admin layout, in each admin page, and **again inside every server action**, so hiding a button is never the protection. The service-role client is only used after that check passes.

- **`/admin/review`:** lists articles with `status='pending_review'`: department, image with its Unsplash credit, the fact-check result, "Based on a source published <date>" with the source link, and editable headline and body.
  - **Save edits** updates headline and body only.
  - **Approve and publish** saves the text as shown, then sets `status='published'` and `published_at`.
  - **Reject** sets `status='rejected'`.
  - Actions only apply to articles still `pending_review`, so a double click or two admins can't act twice. Nothing is re-run after an edit: **edited text is not fact-checked again**, so the reviewer is responsible for it.
- **`/admin/costs`:** tokens and runs per agent per day (UTC) for the last 30 days, from `agent_runs`, with a rough cost estimate. Prices live in `MODEL_PRICES_USD_PER_MTOK` in `lib/config.ts`. They were last checked on 2026-10-12, and the Gemini ones come from third-party aggregators, not Google. `gemini-3.6-flash` has no price set, so rows using it show `>=` (a lower bound) instead of a guess. Check the prices against the providers' pages before relying on the totals.

## Adding sources

Sources are rows in the `sources` table (Supabase Table Editor, or SQL):

```sql
insert into public.sources (name, rss_url, department_id, active)
select 'Example EV News', 'https://example.com/feed.xml', d.id, true
from public.departments d where d.slug = 'ev';
```

`rss_url` must be unique. Every item from a source gets that source's department as its default, and the classifier can still choose another. Set `active = false` to pause a source without deleting its items. To add a department, insert into `departments` with `name`, `slug`, `description` and lowercase `keywords`. For a new department's default image, add `public/images/defaults/<slug>.svg` and its slug to `DEFAULT_IMAGE_SLUGS` in `lib/config.ts`.

## Deleting test data before the pilot

**The easy way:** `npm run stage -- purge-sample` (dev server running, like the other stages) is a **dry run** that lists the sample articles (headline "SAMPLE...", slug `sample-...`, a source on example.com/.org/.net, or an employee submission from a test address such as `@example.com`, `@localhost` or `*.test`), the test submissions, the placeholder sources (`https://example.com/replace-me/...`), the raw items that came from them and the photos in storage, with counts. Read it, then `npm run stage -- purge-sample --apply` deletes them (photo files first; if one cannot be removed nothing is deleted). Departments, real sources, other articles and the spend log are kept. `supabase/seed.sql` now inserts the placeholder sources **inactive**, so they do not fail on every ingest. The older SQL script below still works.

`supabase/seed.sql` only creates departments and placeholder sources (`https://example.com/replace-me/...`). Content produced while testing can be removed with `supabase/delete_sample_data.sql`. It deletes articles whose headline starts with "SAMPLE", whose slug starts with `sample-`, or whose source is on example.com/org/net, plus raw items from example hosts or placeholder sources. It keeps `departments`, `sources` and `agent_runs` (spend history; their article and item ids become null).

1. Open the file in the Supabase SQL editor and run it as is. It ends with `rollback`, so this only **previews** the counts.
2. Check the numbers, including the `published` count.
3. Change the last line to `commit;` and run it again.

To wipe everything produced so far (real feeds included) instead, run `truncate public.articles, public.raw_items cascade;` in the SQL editor. This cannot be undone.

Also replace the placeholder RSS URLs in `sources` with real feeds, or ingest will log a failed feed for each.

## Deploying

Everything needed to put the app in production, in the order to do it. The limits below come from the vendors' own documentation, read in October 2026 (the pages are named so you can check them again before you rely on a number).

### 1. The database

A new project: run `supabase/schema.sql`, then `supabase/seed.sql`. An existing one: run the files of `supabase/migrations/` it has not had yet, **in this order**:

1. `2026-10-14_world_review_pipeline.sql`
2. `2026-10-15_recover_rejected_skipped.sql`
3. `2026-10-15-ai-tech-and-submissions.sql`
4. `2026-10-16_weekly_digest.sql`
5. `2026-10-17_security_and_indexes.sql`
6. `2026-10-18_article_summary.sql`
7. `2026-10-19_reliability.sql`
8. `2026-10-20_privacy_and_hardening.sql`
9. `2026-10-22_review_log_repair.sql`
10. `2026-10-22_story_blocks.sql`

File 9 only repairs `review_log` on a database that never ran file 2 (audit-log writes of restore and mark-relevant failed with a missing column or the action check); it changes nothing if file 2 was run.

Then `GET /api/cron/health` (with the cron secret) lists anything still missing and the file that fixes it, and `npm run check-rls` shows what the public key can read (it must be nothing except published articles and the department names).

### 2. Running the scheduled jobs: GitHub Actions (Hobby)

The pipeline stages, the weekly digest and the weekly cleanup are routes under `/api/cron/` that something has to call on a schedule, with `Authorization: Bearer $CRON_SECRET`. The repository is set up for the Vercel **Hobby** plan: `vercel.json` has **no crons**, and two GitHub Actions workflows call the routes (`.github/workflows/pipeline.yml`, `.github/workflows/digest.yml`). Step by step: `docs/DEPLOY_VERCEL.md`. Never schedule the same jobs in `vercel.json` as well: each job would run twice (the stage lock stops an overlap, but the second call is wasted, and the workflow reports its 409 as a failure).

| | GitHub Actions (`pipeline.yml`, `digest.yml`) |
|---|---|
| Plan needed | any Vercel plan, including Hobby; a GitHub repository |
| Schedules | ingest and classify twice a day, write, image and fact-check every 4 hours, cleanup weekly, digest on Mondays; all in UTC |
| Precision | a delay of some minutes is normal; GitHub can delay runs when it is busy |
| Setup | deploy (the Git integration reads `vercel.json`, which has no crons), add the repository secrets `SITE_URL` and `CRON_SECRET` |
| Watch out for | scheduled workflows run only on the default branch, and in a public repository GitHub switches them off after 60 days without repository activity |

On **Pro** you could move the schedules back into `vercel.json` (`"crons": [{ "path": "/api/cron/ingest", "schedule": "0 * * * *" }, ...]`) and turn the workflows off; Vercel then sends `CRON_SECRET` as the bearer token by itself.

What the documentation says (Vercel, "Usage & Pricing for Cron Jobs", updated 2026-07-15):

| Plan | Cron jobs per project | Shortest interval | Precision |
|---|---|---|---|
| Hobby | 100 | once per day | per hour (a job set for 01:00 can run any time from 01:00 to 01:59) |
| Pro | 100 | once per minute | per minute |
| Enterprise | 100 | once per minute | per minute |

On Hobby, "cron expressions that would run more frequently [than daily] will fail during deployment", and a daily job can start any time within its hour, so Vercel's cron cannot keep the stages in order (ingest, then classify half an hour later, and so on). That is why the schedules live in GitHub Actions and `vercel.json` has none.

Function duration (Vercel, "Configuring Maximum Duration", updated 2026-08-24, with fluid compute, which is on by default): **Hobby: default 300 s, maximum 300 s. Pro and Enterprise: default 300 s, maximum 800 s** (up to 30 minutes in a beta). The audit's remark that Hobby caps functions at 60 s is out of date. The cron routes still declare `maxDuration = 60` because each stage ends itself at `STAGE_TIME_BUDGET_MS` (50 s); the review page declares 300 because "Run next batch" runs up to five LLM calls of up to `LLM_TIMEOUT_MS` (45 s) inside one server action (5 x 45 s = 225 s), and 300 s is the most that every plan allows.

GitHub (docs, "Events that trigger workflows"): the shortest scheduled interval is every 5 minutes; schedules run in UTC; a run can be delayed during periods of high load; scheduled workflows run only on the default branch; in a public repository they are disabled automatically when there has been no repository activity for 60 days.

**Setup:**

1. Deploy to Vercel (Git integration or `vercel deploy --prod`). `vercel.json` has no crons, so it deploys on Hobby.
2. In the GitHub repository: Settings > Secrets and variables > Actions > add `SITE_URL` (`https://your-domain`, no trailing slash) and `CRON_SECRET` (the same value as in Vercel).
3. Actions tab > "Pipeline" > Run workflow > choose `ingest` once by hand and check that it succeeds. The step prints the HTTP status; anything other than 2xx fails the run (a 409 means that stage was already running).
4. Look at the Actions tab every now and then (and after 50 quiet days in a public repository).

`lib/deploy.test.ts` checks that `vercel.json` has no crons, that every schedule in the workflows maps to a route that exists, and that the secret is only ever sent in the header.

### 3. The production environment

Set these in the Vercel project (Production scope). `npm run check-env -- --production` checks the list below against your `.env.local` (and `.env.production*`) and the process environment, and fails with the reasons. Run it locally against the production values before the first deploy, or put it in front of the build (`npm run check-env -- --production && next build`).

| Variable | Production value / action |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the production project (not localhost) |
| `SUPABASE_SERVICE_ROLE_KEY` | server-only; never in a `NEXT_PUBLIC_` variable (the check refuses it); rotate it if it was ever exposed |
| `CRON_SECRET` | at least **32** random characters; the same value in the GitHub repository secret `CRON_SECRET`; it also signs the admin session cookie |
| `ADMIN_EMAILS` | one line, company addresses only, each invited in Supabase Auth. The check refuses placeholders (`example.com`, `test@...`), personal mailboxes (gmail, outlook, yahoo, icloud, ...) and, when `ALLOWED_EMAIL_DOMAINS` is set, addresses outside it |
| `ALLOWED_EMAIL_DOMAINS` | the company domain: required, or `/submit` accepts any email |
| `SITE_URL` | the public **https** address; not localhost (the check refuses both) |
| `PRIVACY_CONTACT` | an address that is read: `/submit` shows it for requests to see or delete data |
| `EMAIL_PROVIDER`, `MAIL_FROM`, `SMTP_*` or `MS_*` | quote `SMTP_PASS` in a `.env` file (`SMTP_PASS='...'`); paste it raw in Vercel; `SMTP_PASS` must not be empty with `EMAIL_PROVIDER=smtp`. With `none` there is no digest and no failure alert email |
| `LLM_PROVIDER` + its key, `UNSPLASH_ACCESS_KEY` | set. Remove every key the app does not read: `PEXELS_API_KEY` and any other (the check lists them) |
| `BATCH_LIMIT`, `DAILY_BUDGET_USD`, `LLM_TIMEOUT_MS` | set on purpose (volume, the daily spend cap, the call timeout) |
| `SUBMITTER_IP_RETENTION_DAYS`, `SUBMITTER_EMAIL_RETENTION_DAYS` | 7 and 90 unless you decide otherwise; the notice on `/submit` quotes them |
| `CSP_MODE` | `report-only` for the first days, then `enforce`. Read at **build** time: change it, then deploy again |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` | optional: both to turn the check on `/submit` on, neither to leave it off |
| `APP_URL` | local only (for `npm run stage`): do not set it in production (the check refuses it). The workflows use the repository secret `SITE_URL`, not this |

### 4. Launch checklist

1. Run the migrations (above), then `npm run check-env -- --production`. Fix what it lists.
2. Deploy. Call each cron route once by hand (`curl -H "Authorization: Bearer $CRON_SECRET" https://<your-domain>/api/cron/health`, then the stages), or run the workflow once.
3. `npm run check-rls`: every line OK. A WARN about an empty table only means nothing proves the rows are protected until the table has rows.
4. Supabase dashboard: turn off public sign-ups, invite the admins, enable MFA for them, set the session limits.
5. Clear the test content: `npm run stage -- purge-sample` (a dry run that lists it), read the list, then `npm run stage -- purge-sample --apply`.
6. `npm run stage -- cleanup` (a dry run) to see what the retention job will touch each week.
7. Backups: read `docs/BACKUP.md`, write down what your plan includes, take a manual dump and run `npm run backup:check`.
8. Send a digest to yourself, then to a small list. Submit a story from a company address and from an outside address (the second must be refused); approve it; check the byline, and that no email appears at `https://<project>.supabase.co/rest/v1/articles?select=*` with the anon key.
9. After a few days of the policy in `report-only` without "CSP violation" lines in the logs (they come from `/api/csp-report`), set `CSP_MODE=enforce` and deploy again.

Cookies need no change (host-only cookies on the production domain, `Secure` on https). In Supabase Auth set the Site URL and redirect URLs to the production domain.

## AI & Technology department

A company department (`slug ai-technology`) for AI and machine learning, LLMs and generative AI, AI regulation and safety, robotics and automation, semiconductors and AI chips, cloud and data-centre technology, and cybersecurity. The migration creates it with six feeds (MIT Technology Review AI, The Verge AI, Ars Technica Technology Lab, IEEE Spectrum AI, Google AI blog, TechCrunch AI). Each was fetched and parsed with the project's own User-Agent and parser on 2026-10-15; VentureBeat answered 429 and is not seeded.

The classifier still assigns **one** department. `AI_TECH_GUIDANCE` in `lib/pipeline/classify.ts` is added to its prompt whenever the department exists: a story that is mainly about AI/ML goes to AI & Technology even if it could also fit Software Development. The rule sits in the code, so editing the department's description in the database cannot remove it. Colours: tag `#BABFBA` (a pastel of deep sage) and marker `#657166`, the one palette colour no other department uses (`lib/news/departments.ts`).

## Employee submissions

`/submit` is public (no login) with a **Write** button in the dashboard header; it is the **Write** page, described in the next section (stories are made of blocks). The checks below (email domain, limits, honeypot, IP hash, privacy) apply to it unchanged; the older description of a single text box and one photo is kept for the fields that are still the same. The form is validated again on the server with zod (`lib/submissions/schema.ts`), and the story is written with the service role only after that. There is no public insert policy anywhere.

- **Fields:** first and last name, company email, the author's own department (`SUBMISSION_AUTHOR_DEPARTMENTS` in `lib/config.ts`), the sector the story is for (the company departments, AI & Technology included), title (5-140 characters), text (200-6000 characters, plain text, each line break a paragraph), optional country (India preselected), optional photo with a credit or caption, and two required confirmations. Control characters, zero-width and bidi override characters are removed. Nothing is interpreted as HTML or markdown, and everything is escaped on output.
- **Email:** must end with one of `ALLOWED_EMAIL_DOMAINS` (whole-domain match, so `evil-adorpower.com` fails). With the variable empty any email is accepted and the story is flagged **unverified** for the admin. "Verified" here only means the domain matched; the mailbox itself is not confirmed.
- **Photo:** JPEG, PNG or WebP only, up to 5 MB, judged by the file's first bytes, not its name or MIME type. `sharp` turns it upright, drops all metadata (EXIF, GPS, XMP), scales it to at most 1600px wide and saves WebP. It goes to the **private** bucket `submission-images` under a random UUID name. On approval it is copied to the public bucket `article-images` and that URL becomes `image_url`. No photo: the department default image.
- **Abuse protection:** a hidden honeypot field (a bot is told it worked, nothing is stored); at most 3 submissions per IP and 5 per email in a rolling 24 hours; the same email with the same title within 24 hours is refused. IPs are stored only as an HMAC-SHA256 hash (IPv6 reduced to its /64), never raw. If the platform gives no IP, only the email rule applies.
- **Privacy (SEC-13):** the page opens with a short plain-language notice (`app/submit/PrivacyNotice.tsx`, text in `lib/submissions/privacy-notice.ts`): what is stored, who sees it (name and department are the public byline; the email only admins), how long, and how to ask for deletion (`PRIVACY_CONTACT`). Retention is part of the weekly `cleanup` job: `ip_hash` is set to null after `SUBMITTER_IP_RETENTION_DAYS` (7); the email is replaced by `anonymized-<hex>@anonymized.invalid` `SUBMITTER_EMAIL_RETENTION_DAYS` (90) after the story's decision (the latest approve or reject in `review_log`, else its publication date; a story still in review keeps its author's email), after the private copy of the photo has been removed from storage. **Admin > Privacy > "Delete a person's data"** takes an email address, shows what would go (their stories' bylines, the submitter record, photo files in both buckets, a digest subscription), asks you to choose between keeping their stories without a name or also unpublishing them and to type DELETE, does it, and logs it in `privacy_log` with your email, the counts and a keyed hash of the address, never the address. The address is only in the form's state: not in a URL or a log. It does not edit a story's text; if the text names the person, unpublish and edit it. Older dumps and Supabase's own backups are out of its reach (see `docs/BACKUP.md`).
- **Turnstile (optional):** with `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET` both set, the form shows Cloudflare's widget and the server checks the token before reading anything else (a missing, refused or unverifiable token stores nothing). Off when they are unset.
- **Data:** the story is an `articles` row with `status = 'pending_review'`, `origin = 'employee'`, `author_first_name`, `author_last_name`, `author_department`, the chosen department and the country. The author's **email, IP hash, the unverified flag and the photo path** are in `article_submitters`, which no public role can read. The public queries list their columns one by one and `toStory` copies fields one by one, so a stray column cannot reach the browser.
- **Pipeline:** employee stories skip classify, write, image and fact-check (those stages only look at `new` raw items and `draft` articles).
- **Admin (`/admin/review`):** an **Employee submissions** chip with a count. Each card has a badge, the author's name, department and email (admin only), the unverified flag when it applies, the photo preview (a signed URL that expires after 10 minutes), inline editing of title and text, and the note "Written by an employee, not checked by AI: please verify before approving." Approve publishes like any story (`published_at`, audit log) and copies the photo first; if the copy fails the story stays pending. **Reject needs a reason** (checked on the server). Rejected submissions are in the Rejected tab with **Restore**.
- **Public display:** byline "By <First> <Last> · <Department>" and the tag "Employee contribution" instead of "AI-generated" on cards, in the reader and on `/article/<slug>`. In the weekly digest the same byline and tag appear, employee stories have no source line, and the footer says "AI-generated summaries" only when the digest has an AI story. A WebP lead image is attached to the email as a JPEG, because Outlook for Windows cannot show WebP.
- **Limits of the host:** the Write form posts to `POST /api/write/submit`, a route handler that accepts up to 41 MB (eight images of 5 MB and the text); the browser scales each image down first. Vercel's own request limit for functions is about 4.5 MB, so a story whose images add up to more than that can be refused by the platform before it reaches the app: the form then says the story is too large and keeps the draft. `experimental.serverActions.bodySizeLimit` (6 MB) now only matters for the admin actions.
- **Setup check:** `GET /api/cron/health` also reports missing columns (`articles.origin` and the author columns, the `article_submitters` columns, the digest columns), missing or wrongly public/private buckets, and a missing AI & Technology department, each with the file to run.

## Write: block stories, likes and comments

`/submit` (the **Write** page, mark: a pencil on a square outline) is a block editor. The migration is `supabase/migrations/2026-10-22_story_blocks.sql`; nothing is stored in the new tables until it has been run, and the public pages keep working without it (they fall back to the older column lists).

- **The editor** (`components/write/*`, rules in `lib/stories/editor.ts`): a title (5-120 characters), the department the story is for, an optional summary (the card's line, up to 240 characters), then an ordered list of blocks with a **+** before the first block and after every block: Paragraph, Heading (H2/H3), Image, Code, Quote, Bulleted list, Numbered list, Divider, Link. Every block can move up or down and be deleted; blocks can be added anywhere, in any order. An image block has a file, a required description (alt text) and a caption; a code block has a language (JavaScript, TypeScript, Python, SQL, Bash, JSON, C/C++, Java, HTML, CSS, YAML, plain text), an optional file name and a monospaced box that keeps tabs and spaces (Tab indents; Escape then Tab leaves the box). A **Preview** button shows the story with the same component the reader uses. The draft (title, summary, blocks; **not** the name, the email or the image files) is saved in `localStorage` after every change, offered back on the next visit and cleared after sending; the page works without storage. Every control has a label, the "+" menu works with the keyboard (arrows, Escape), and moves and additions are announced.
- **The data:** `articles.body_blocks` (jsonb) and `articles.body_format` (`plain` for AI articles and older stories, `blocks` for Write). The JSON is versioned, `{ "v": 1, "blocks": [ { "id", "type", ... } ] }`, and validated on the server with one strict schema (`lib/stories/blocks.ts`): only the eight block types, at most 60 blocks and 8 images, per-block text limits (paragraph 5000, heading 200, quote 2000, list 50 items of 500, code 20,000, caption and alt 300), at least 200 characters of reading text, at most 100,000 characters in all, links only `http(s)` and without a password, ids of letters, digits, `-` and `_`, unknown fields dropped, unknown types refused. `articles.body` keeps a plain-text version of the blocks (code and images left out), so the digest, the card summary and the page description work as before. Both new columns are in `lib/news/public-columns.ts` and the column grant; the card list does not select them (the feed stays light).
- **Images:** JPEG, PNG or WebP, up to 5 MB each, judged by the file's first bytes (an SVG, a script or a PDF named `.png` is refused, a PNG named `.svg` is accepted). The browser scales an image to at most 1600 px first (the request carries up to eight); the server then re-encodes every image with `sharp` (upright, all EXIF/GPS/XMP dropped, WebP) and stores it in the **private** `submission-images` bucket as `<story id>/<block id>.webp`. **Approve** copies each image to the public `article-images` bucket, rewrites its block to the public address (the private path is removed from what the public can read) and, if the story only has the department's default picture, uses the first image on the feed card. If a copy fails the story stays pending and the files already copied are removed. **Reject** keeps the images private; the cleanup job removes them with the rest of the author's private data (see Privacy).
- **The author's name:** the form has a "Show my name and department on the story" box, off by default. Off: the public byline columns hold "Newsroom" / "contributor" (the database requires a name on an employee story) and the real name and department are only in `article_submitters`, which the public cannot read; the review card tells the editor who wrote it. Retention clears those private copies together with the email.
- **Admin review:** a pending Write story shows the rendered story (the same component as the reader, images through 10-minute signed links), read-only: the editor can change the headline, approve, or reject with a reason; the blocks and the text are not edited (the server ignores a posted body for a Write story). The **Published** tab has a **Comments** list under every published Write story, hidden comments included, with **Hide** (with an optional reason) and **Show again**; each change is a row in `comment_log` (who, when, why). A hidden comment is not public.
- **The reader** (the slide-in panel and `/article/<slug>`; the frame, the chips, the title and the byline are unchanged): a 680 px column in the serif face, headings, full-width images with captions, quotes with a left rule, lists, dividers, link cards, the department, date, author line and reading time. Code blocks are a dark panel with a header bar (language, file name, **Copy**), horizontal scroll (never wrap) and syntax colours. **Copy** copies the exact text (tabs included), falls back to the old method when the clipboard API refuses, shows "Copied" for 2 seconds and says "Copy failed" if nothing worked. The highlighter (`lowlight` and 11 grammars, rendered as React elements: no HTML string, no `dangerouslySetInnerHTML`, colours from classes in `globals.css`, no inline styles) is its own chunk, loaded by the first code block that appears, never by the homepage; the Write story reader is also loaded only when a Write story is opened. AI-written articles are drawn exactly as before.
- **Bundle size** (`npm run bundle-size`: builds against the local mock and adds up the JavaScript the homepage loads): the homepage went from 630,223 to 632,066 bytes (+1,843 bytes, +0.3%; gzip 196,522 to 197,267, +745 bytes). The highlighter chunk is 75,912 bytes (24,253 gzip) and the Write reader chunk 52,466 bytes (18,446 gzip); the script is checked to find neither on the homepage. The `/submit` page is heavier than before (the editor and zod).
- **Likes and comments** need a company email that is proved, and the site has no employee sign-in, so a reader signs in with a **one-time code**: they type a company address (it must end with one of `ALLOWED_EMAIL_DOMAINS`), the server mails a 6-digit code (valid for 10 minutes, five tries, one use; five codes an hour per address and twenty per connection), and a correct code starts a 14-day session (a signed, HttpOnly, SameSite=Lax cookie; Secure on https). What is stored is only a keyed hash of the address (`user_key`, the same secret as the IP hashes: `SUBMISSION_HASH_SALT`, else `CRON_SECRET`); the address itself is never kept. A comment shows the first name taken from the address ("ada.lovelace@..." is "Ada"). There are no anonymous likes or comments. **This needs `EMAIL_PROVIDER` set to `smtp` or `graph` with `MAIL_FROM`, and `ALLOWED_EMAIL_DOMAINS` set;** otherwise the reader says likes and comments are not switched on (`npm run check-env -- --production` warns about it). A wrong-code try is counted by the database before the comparison (`reader_code_attempt`), so parallel guesses cannot get more than five.
- **Limits:** a like toggle is counted whether it likes or unlikes (30 an hour, 200 a day); comments are 2-1000 characters, five an hour and twenty a day per person, control characters removed, the same text twice refused (ignoring case and spacing; a hidden comment still counts towards the limit). Counts are public only through the `article_like_counts` view (counts of published articles, never who liked); visible comments of published articles are public through row-level security with column grants that leave out `user_key`; everything that writes goes through server routes with the service role (`/api/reader/*`, `/api/story/<slug>/{engagement,like,comments}`), each of which also refuses requests that do not come from this site (Origin / Sec-Fetch-Site, and JSON only). `npm run check-rls` checks the new tables. Likes and comments are only offered on Write stories, never on AI articles.
- **Privacy:** the notice on the form says what is stored and for how long. **Delete a person's data** also deletes the person's likes, comments, sign-in codes and like log (found through the keyed hash of the address) and the private images of their stories; the retention job clears the private images, the real name and the department when it anonymizes the email. A story's text and its public images are the story's content and are not edited by the tool (as before).
- **Security:** no raw HTML anywhere (blocks are React elements built from the validated JSON; `<script>` and `<img onerror>` in any field are drawn as text; tests render hostile stories); links open with `rel="noopener noreferrer nofollow"` and `target="_blank"` and only for `http(s)`; trojan-source characters are stripped from code. The form's own validation runs zod in its `jitless` mode in the browser, because zod's default compiles with `new Function`, which a policy without `'unsafe-eval'` forbids; the new components use no inline styles, so the policy needs nothing beyond what it already allows, and `npm run e2e` fails on any Content-Security-Policy violation on the submit, reader, article and admin pages.
- **Setup check:** `GET /api/cron/health` also reports the new tables and columns, with the file to run.

## Security headers and database access

`next.config.ts` sends `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY` with `Content-Security-Policy: frame-ancestors 'none'`, a `Permissions-Policy` that turns camera, microphone and geolocation off, and (production only) `Strict-Transport-Security`; `X-Powered-By` is off. A **Content-Security-Policy** is sent too (`lib/csp.ts`): as `Content-Security-Policy-Report-Only` by default, so a violation is reported to `/api/csp-report` (one log line, nothing stored) and nothing is blocked, or as the enforced `Content-Security-Policy` when `CSP_MODE=enforce`. It is read when the app is built, so after changing `CSP_MODE` deploy again.

The policy: `default-src 'self'`; `object-src 'none'`; `base-uri 'self'`; `form-action 'self'`; `frame-ancestors 'none'`; `img-src` only this site, `data:`, `images.unsplash.com` and the Supabase host (the photos of employee stories); `connect-src` only this site and the Supabase host; `font-src 'self'` (next/font serves the fonts from here). Cloudflare's host is added to scripts, frames and fetches only when Turnstile is on.

**The trade-off, and why.** A nonce-based policy (`'nonce-...'` with `'strict-dynamic'`) makes every page render on every request, because the nonce must differ each time and is written into the HTML while it is rendered: the homepage and `/article/<slug>` would stop being cached (`revalidate = 60`) and the cached-page work of the performance batch would be undone. Next's other way, hashes via Subresource Integrity (`experimental.sri`, experimental), covers the script *files*; a statically rendered Next page also has small inline scripts (`self.__next_f.push(...)`) that carry the page's data, and their text changes with every revalidation, so no hash can be written in advance. So the policy allows inline scripts (`'unsafe-inline'` in `script-src`) and is strict about everything else: no script from any other host, no `eval` in production, no remote images or fetches, no framing, no plugins. What that costs: an injected inline script would run (the CSP does not stop that), but it could not load another script, send data to an arbitrary host or embed foreign content. `style-src` also allows `'unsafe-inline'` because React components set `style=""` attributes (the globe, the card colours). If the pages ever have to be dynamic anyway, switch to the nonce policy of the Next.js CSP guide and drop `'unsafe-inline'`; the reasoning is written at the top of `lib/csp.ts`.

The anon and authenticated database roles may read only the public columns of `articles` (column-level `SELECT` grants, first in `supabase/migrations/2026-10-17_security_and_indexes.sql`, replaced by the current list in `2026-10-18_article_summary.sql`, mirrored by `lib/news/public-columns.ts`; a test keeps them equal). `fact_check_notes`, `review_note`, `image_query`, `raw_item_id` and the other internal columns are invisible to the public REST API, and `select=*` as anon fails. **A new column on `articles` is private until it is added to both lists.** `GET /api/cron/health` checks this with the public key.

## Public homepage (dashboard)

`/` is a dashboard of published stories: a feed on the left, a rotating globe with one marker per story on the right, a slide-in reader, and a headline ticker. `/article/<slug>` is a standalone page for sharing. Both read with the anon key, so RLS guarantees only `published` articles come back, and neither shows source text: they link to the original instead.

- **Data:** `app/page.tsx` loads the newest 60 published articles with their department and passes them to `components/dashboard/Dashboard.tsx`. The list carries no bodies: each article has a stored `summary` (the first 240 characters of its body, cut at a word boundary; filled by the writer, by `/submit` and whenever an editor changes the body). **Load more** fetches the next 60 from `GET /api/stories?offset=`. Search and the department chips work on the stories loaded so far and say so, with the Load more button beside them. The full body is fetched when a story is opened, from `GET /api/story/<slug>`; `/?story=<slug>` deep links work for any published story, loaded or not.
- **Caching:** `/` and `/article/<slug>` are cached for 60 s (`revalidate = 60`) and read through the cookie-free client in `lib/supabase/public.ts` (a page that reads cookies cannot be cached). Approving, unpublishing, restoring or editing a story calls `revalidatePublicSite()` (`lib/news/revalidate.ts`), which drops the cache tag `stories` and the two paths at once. A change made straight in the database shows within 60 s.
- **Globe:** loaded as its own chunk after the first paint (a plain circle stands in meanwhile). The canvas uses at most 2x pixel density, draws the glow once, pauses while it is scrolled out of view or the tab is hidden, and rotates by itself at 30 fps when `navigator.hardwareConcurrency` is 4 or less.
- **Bundle report:** `ANALYZE=true next build --webpack` (add `ANALYZE_MODE=json` for a JSON file) writes `.next/analyze/`; it is a Webpack plugin (`@next/bundle-analyzer`). For Turbopack use `next experimental-analyze`. The write stage copies `place`, `lat` and `lon` from the article's source onto the draft, so set them on each row in `sources` (nullable; a story without coordinates appears in the feed but not on the globe).
- **Selection:** `/?story=<slug>` opens the reader and points the globe at the story. Browser back closes it.
- **Filters:** the department tabs and the search box (headline and place) filter the feed and the markers together.
- **Globe land:** `public/land-dots.json` is generated from Natural Earth data (`world-atlas`) by `npm run build:land`. It is committed, so you only re-run it to change the dot spacing in `scripts/build-land-dots.ts`.
- **Colours:** palette tokens are CSS variables in `app/globals.css`. Department chip and marker colours are in `lib/news/departments.ts`, matched by slug; a new department gets deep sage until you add it there.
- **Source name:** anonymous visitors can't read the `sources` table, so the story's source is shown as the host of its URL (for example `reuters.com`).

## Reliability

What keeps the pipeline from hanging, overspending or being used against the server. The SQL is in `supabase/migrations/2026-10-19_reliability.sql` (also in `schema.sql`); the app keeps working before it is run, but the stage lock, the limit raises and the cleanup need it. `GET /api/cron/health` reports what is missing.

- **Time budget for ingest (BE-01):** like the other stages, ingest stops starting feeds and pages after `STAGE_TIME_BUDGET_MS` and cuts each request's timeout to the time left. What it did not reach is reported as `deferred` items and `sourcesDeferred` feeds (`stopped: "time_budget"`), the next run picks it up, and the run is recorded in `pipeline_runs` as usual.
- **LLM timeout (BE-02):** a call that does not answer within `LLM_TIMEOUT_MS` is abandoned. It is not retried inside the same call (each retry would wait a whole timeout again): the result is `provider_error`, the item stays queued and the batch stops, as for any provider outage.
- **Daily spend cap (BE-04):** before every LLM call `callAgent` checks today's spend (the `agent_runs` of the Asia/Kolkata day, priced by `MODEL_PRICES_USD_PER_MTOK`) against `DAILY_BUDGET_USD`. At the cap nothing is sent to the provider, stages end cleanly with `stopped: "budget_exceeded"`, items stay queued (never failed), and every admin page shows a red banner with **Raise today's limit**. A raise is admin only, must be higher than the current limit (at most $1000), holds until midnight IST and is stored with the admin's email in `budget_overrides` and written to the log. A model with no price (`gemini-3.6-flash` today) is counted at the highest known price, so the cap still means something; the check allows the call if the spend cannot be read.
- **One run per stage (BE-05):** a stage first writes a "running" row to `pipeline_runs`; a unique index allows one per stage, so cron and the admin button cannot run the same stage at once. The second gets `409` (cron) or "<stage> is already running" (admin) and does nothing. A row older than 10 minutes that never finished is closed as failed and no longer blocks.
- **Repeated failures (BE-06):** when a stage has failed twice in a row, `/admin` shows a banner. If email is configured (`EMAIL_PROVIDER`, `MAIL_FROM`, `ADMIN_EMAILS`) the admins also get one email for that streak (BCC); the third failure sends nothing, and a success starts over. Without email the banner is all there is.
- **Digest stuck or failed (BE-03):** a digest in "sending" for more than 15 minutes is shown as stuck on `/admin/digest`, with **Mark as failed** (admin only, logged, not offered earlier). A failed digest has **Retry**: it goes back to approved and is sent at once (the same one-winner claim as Send now; recipients of batches that had already gone out get it again, as the dialog says). An approved digest whose last attempt failed shows that error and can be sent with Send now. When a send succeeds the provider's message id (SMTP `messageId`, Graph `request-id`) is written to `digest_log`, one per batch.
- **No server-side request forgery (SEC-07):** feeds and article pages are fetched by `fetchText` (`lib/ingest/fetch.ts`), which checks every URL with `lib/ingest/ssrf.ts` before it is requested and after each redirect (followed by hand, at most 3): http or https only, port 80 or 443, no credentials, and a host that is not, and does not resolve to, a loopback, private, link-local (169.254.x.x, the cloud metadata address), carrier-grade NAT, multicast or reserved address (IPv4 and IPv6, including IPv4-mapped forms and numeric tricks like `2130706433`). One gap: the name is resolved for the check and again by `fetch`, so a DNS server that changes its answer between the two (rebinding) is not stopped; pinning the connection needs a custom dispatcher.
- **Retention (DB-03):** `public.run_retention` clears `raw_items.full_text` of written/skipped items older than 14 days, deletes `raw_items` older than 90 days that have no article, and deletes `agent_runs` and `pipeline_runs` older than 12 months. `GET /api/cron/cleanup` (bearer `CRON_SECRET`) is a **dry run** that only counts; `?apply=true` does it. `npm run stage -- cleanup` is the dry run and `npm run stage -- cleanup --apply` the real one (dev server, like the other stages). Both log how many rows each step touched. The weekly run in `.github/workflows/pipeline.yml` (Sundays 01:15 UTC) uses `apply=true`; run a dry run first and look at the numbers. The same job also applies the privacy rules for `/submit` (the submitter's IP hash and email; see **Employee submissions**).
- **Departments (DB-05):** `articles.department_id` is `on delete restrict`: a department that still has articles cannot be deleted.

## Weekly run

`npm run stage -- all` (dev server running) calls ingest, classify, write, image and fact-check in order, repeating each until its queue is empty or the provider rate-limits, then prints processed / remaining / rejected per stage. A rate-limited stage leaves its items queued (never failed); run it again later. Cron routes stay one stage per call.

Admin: **Rejected** (restore to review) and **Skipped** (mark relevant, then write -> image -> fact-check picks them up) tabs, plus a **Run next batch** button on **Pipeline**. Run `supabase/migrations/2026-10-15_recover_rejected_skipped.sql` first.

## Weekly email digest

Mondays: `digest-draft` (03:00 UTC, 08:30 IST) builds the draft from the last 7 days of published stories not used by an earlier digest; an admin reviews it at **/admin/digest** (live preview, edit, reorder, test to self, Download .eml, Approve); `digest-send` (05:30 UTC, 11:00 IST) sends it only if it is **approved**. A draft is never sent: the admins get a "Digest waiting for your approval" email instead. A digest is sent once (atomic `approved -> sending`). Run `supabase/migrations/2026-10-16_weekly_digest.sql` first; `GET /api/cron/health` reports any missing table.

Set `SITE_URL`, then pick `EMAIL_PROVIDER`: `none` (default: preview and .eml only), `smtp` (Microsoft 365: `smtp.office365.com:587` STARTTLS; the mailbox needs SMTP AUTH enabled by IT) or `graph` (app registration with `Mail.Send`). See `.env.example`. Mail settings are validated only for the provider you pick, and secrets and recipient addresses are never logged.
