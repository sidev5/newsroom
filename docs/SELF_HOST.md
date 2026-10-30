# Self-hosting on a Windows PC (NSSM, plain http on the company LAN)

This runs the app as a Windows service on one PC, reachable by colleagues at `http://<pc-name>:3000`. The Vercel / https deployment is unaffected: nothing below changes what `next start` or Vercel do.

**Read "What plain http means" before you start.** Over http everything (pages, the reader sign-in code, session cookies, and the admin password if you allow it) crosses the network unencrypted. The setup below keeps `/admin` on the server PC only, which removes the worst of it.

## What plain http means for this app

### Cookies

Every cookie the app sets is `HttpOnly; SameSite=Lax` and gets `Secure` **only when the request came over https** (`isHttps()` in `lib/supabase/cookies.ts`). On `http://<pc-name>:3000` none of them is `Secure`, so browsers accept them, and they travel in clear text.

| Cookie | Set by | Lifetime | Over http |
|---|---|---|---|
| `sb-<project>-auth-token` (and `.0`, `.1` chunks) | Admin sign-in (`app/admin/login/actions.ts`, `proxy.ts`, `lib/supabase/server.ts`) | Capped at `ADMIN_SESSION_HOURS` (8 h) | Works. Not `Secure`: readable by anyone who can see the traffic, who could then act as the admin until it expires. |
| `nr_admin_activity` | Admin sign-in and every `/admin` request (`lib/admin/activity.ts`) | `ADMIN_SESSION_HOURS` | Works. Same exposure (it is signed, so it cannot be forged, but it can be copied with the session above). |
| `newsroom_reader` (`lib/reader/identity.ts`) | `/api/reader/verify` after the emailed code | 14 days | Works. Not `Secure`: someone who captures it can like and comment as that reader for 14 days. |

Why nothing breaks: `next start` (and the self-host server) report `x-forwarded-proto: http` for a direct connection, so `isHttps()` is false and `Secure` is left off. If `Secure` were set on an http page, Chrome, Edge and Firefox would silently drop the cookie and admin sign-in would loop back to the login page. That would happen if something in front of the app wrongly said `X-Forwarded-Proto: https`.

### Admin sign-in

Works over http. The password goes from the browser to this PC **unencrypted** (from this PC to Supabase it is https). Hence the default below: `/admin` only on the server PC itself, where the traffic never leaves the machine.

### Reader sign-in (likes and comments)

Works. It is an emailed 6-digit code, checked by the app (no Supabase redirect, so Supabase's Site URL / redirect settings play no part). The address and code are unencrypted on the LAN; the code works once, for 10 minutes.

### "Copy" button on code blocks

`navigator.clipboard` exists only on secure pages (https or `localhost`), so on `http://<pc-name>:3000` it is missing. `components/story/copy.ts` then falls back to `document.execCommand("copy")`, which current Chrome, Edge and Firefox still allow on a click. Expect it to work; if a browser or a company policy blocks it, the button says "Copy failed" and the reader selects the text by hand. On the server PC itself (`http://localhost:3000`) the clipboard API is used normally.

### Other http effects

- **HSTS.** A production build sends `Strict-Transport-Security: max-age=31536000; includeSubDomains`. Browsers ignore it over http, so it does no harm here. But HSTS covers the whole host name on every port: if `<pc-name>` is ever served over **https** (an IIS site on 443, say), browsers that visit it will refuse `http://<pc-name>:3000` for a year. Do not mix the two on the same name.
- **One address.** Cookies belong to the exact host name. Signing in at `http://pc-name:3000` does not sign you in at `http://pc-name.corp.example:3000` or `http://10.0.0.5:3000`. Tell people one address.
- **Cloudflare Turnstile** (only if `TURNSTILE_*` is set): add `<pc-name>` (and the full name if people use it) to the widget's hostnames in the Cloudflare dashboard, or `/submit` cannot be sent. Test it from another PC.
- **Per-address limits** on `/submit` and on reader codes use the client address. Plain `next start` keeps an `X-Forwarded-For` header sent by the client, so a LAN user could fake their address and dodge the limits. The self-host server replaces those headers with the real socket address.

## Who may reach /admin

`npm run start:lan` (`scripts/self-host-server.mjs`) wraps the app. It decides with `SELF_HOST_ADMIN`:

| `SELF_HOST_ADMIN` | Effect |
|---|---|
| unset or `localhost` **(default, recommended)** | `/admin` answers only on the server PC (`http://localhost:3000/admin`). Other machines get **404**. The login action and every admin action refuse other machines too, even if posted to another path. |
| `lan-insecure-http` | `/admin` is open to the whole LAN over plain http. The server prints a warning at every start, and the login page shows a red warning to every visitor from another machine. Use it only on a trusted, wired network and only until https is set up. Any other value (a typo, wrong case) means `localhost`. |

How the "only this PC" check works (`lib/admin/network.ts`): the server deletes any `Forwarded`, `X-Forwarded-*`, `X-Real-IP` and `x-newsroom-client` header the client sent, then passes the real socket address to the app in `x-newsroom-client`, together with a random token created at each start. The app believes the address only with that token. Without the self-host server (plain `next start`, Vercel) there is no token and no rule, exactly as before. Under the `localhost` policy, a missing or wrong token means **refused** (fail closed).

An admin who must work from their own desk can use Remote Desktop to the server PC and open `http://localhost:3000/admin` there. RDP is encrypted; the http hop stays inside the PC.

## Install

Run these in an **elevated** PowerShell on the server PC. Paths below use `D:\newsroom` for the app and `D:\newsroom-logs` for logs; change them as you like.

1. **Node.js 24 LTS** from nodejs.org (the installer puts `node.exe` in `C:\Program Files\nodejs\`). Check: `node --version`.
2. **NSSM** from nssm.cc: unzip and put `win64\nssm.exe` somewhere on `PATH` (e.g. `C:\Tools\nssm\nssm.exe`).
3. **The app**: copy the repository to `D:\newsroom` (git clone, or a copy without `node_modules` and `.next`), then:

   ```powershell
   cd D:\newsroom
   npm ci
   ```

4. **`.env.local`** in `D:\newsroom`, filled in as in `.env.example`. For the LAN:

   ```
   SITE_URL=http://<pc-name>:3000
   # optional: HOST=0.0.0.0  PORT=3000  SELF_HOST_ADMIN=localhost
   ```

   Do not set `APP_URL` here. Check it with `npm run check-env` (not `-- --production`: that check requires an https `SITE_URL` and will fail on purpose).

   Lock the file down, since it holds the service-role key and every other secret (replace `svc-newsroom` with the service account from step 6):

   ```powershell
   icacls D:\newsroom\.env.local /inheritance:r /grant:r "Administrators:F" "SYSTEM:F" "svc-newsroom:R"
   ```

5. **Build**:

   ```powershell
   npm run build
   ```

   `CSP_MODE` and the Turnstile keys are read at build time: change them, then build again.

6. **A service account** (recommended over LocalSystem): a local standard user, e.g. `svc-newsroom`, with a long random password, not in Administrators. Give it read access to `D:\newsroom` and modify access to `D:\newsroom\.next` (Next writes its cache there) and `D:\newsroom-logs`:

   ```powershell
   New-Item -ItemType Directory -Force D:\newsroom-logs
   icacls D:\newsroom /grant "svc-newsroom:(OI)(CI)RX"
   icacls D:\newsroom\.next /grant "svc-newsroom:(OI)(CI)M"
   icacls D:\newsroom-logs /grant "svc-newsroom:(OI)(CI)M"
   ```

## NSSM service

```powershell
$app = "D:\newsroom"
nssm install Newsroom "C:\Program Files\nodejs\node.exe" "$app\scripts\self-host-server.mjs"
nssm set Newsroom AppDirectory $app
nssm set Newsroom AppEnvironmentExtra "NODE_ENV=production"
nssm set Newsroom DisplayName "Newsroom (LAN)"
nssm set Newsroom Description "Company newsroom, plain http on the LAN. See docs\SELF_HOST.md."
nssm set Newsroom Start SERVICE_DELAYED_AUTO_START
nssm set Newsroom AppStdout "D:\newsroom-logs\out.log"
nssm set Newsroom AppStderr "D:\newsroom-logs\err.log"
nssm set Newsroom AppRotateFiles 1
nssm set Newsroom AppRotateOnline 1
nssm set Newsroom AppRotateBytes 10485760
nssm set Newsroom AppExit Default Restart
nssm set Newsroom AppRestartDelay 5000
nssm set Newsroom AppStopMethodConsole 10000
nssm set Newsroom ObjectName ".\svc-newsroom" "<the account's password>"
nssm start Newsroom
```

- If the start fails with error 1069 (logon failure), give the account **Log on as a service** in `secpol.msc` > Local Policies > User Rights Assignment, then `nssm start Newsroom` again.
- Check: `nssm status Newsroom`, then `Get-Content D:\newsroom-logs\out.log -Tail 20`. You should see `Newsroom listening on http://0.0.0.0:3000` and, with the default policy, `/admin answers only on this PC`.
- Secrets live in `.env.local`, not in NSSM's `AppEnvironmentExtra` (which is stored readable in the registry).
- Logs rotate at 10 MB and on each restart. They can contain error details about requests; keep them readable by administrators only and delete old ones from time to time.

### Updating

```powershell
nssm stop Newsroom
cd D:\newsroom
# copy or `git pull` the new version
npm ci
npm run build
nssm start Newsroom
```

## Windows Firewall

Open TCP 3000 for the company network only, not on the Public profile:

```powershell
New-NetFirewallRule -DisplayName "Newsroom (LAN, TCP 3000)" -Direction Inbound -Action Allow `
  -Protocol TCP -LocalPort 3000 -Profile Domain,Private -RemoteAddress LocalSubnet `
  -Program "C:\Program Files\nodejs\node.exe"
```

- `LocalSubnet` allows only this PC's own subnet. If colleagues are on other subnets, replace it with the company ranges, e.g. `-RemoteAddress 10.0.0.0/8,192.168.0.0/16`.
- Make sure the PC's network is classified Domain or Private: `Get-NetConnectionProfile`.
- Windows may also have asked to allow `node.exe` the first time it listened; if you clicked "Allow" for Public networks there, remove that rule in `wf.msc` > Inbound Rules (look for "Node.js").
- To bind to one interface only, set `HOST=<the PC's LAN IP>` in `.env.local`. Note that `localhost` then no longer reaches the app, so leave `HOST` at `0.0.0.0` with the default admin policy.

## Task Scheduler (replaces Vercel Cron)

The pipeline and maintenance jobs are GET requests with `Authorization: Bearer <CRON_SECRET>` (`lib/cron-auth.ts`), listed in `.github/workflows/pipeline.yml` and `digest.yml`. On this PC, Task Scheduler calls them on `http://127.0.0.1:3000`, so the secret never leaves the machine.

### 1. The caller script

Save as `D:\newsroom-cron\call.ps1` (outside the app folder, so updates do not overwrite it):

```powershell
param([Parameter(Mandatory)] [string] $Path)
$ErrorActionPreference = "Stop"
# CRON_SECRET from .env.local, so it is not written in the task's arguments (visible to any local user).
$line = Get-Content "D:\newsroom\.env.local" | Where-Object { $_ -match '^\s*CRON_SECRET\s*=' } | Select-Object -Last 1
if (-not $line) { throw "CRON_SECRET not found in .env.local" }
$secret = ($line -replace '^\s*CRON_SECRET\s*=\s*', '').Trim().Trim("'").Trim('"')
$log = "D:\newsroom-logs\cron.log"
try {
  $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:3000$Path" -Headers @{ Authorization = "Bearer $secret" } -TimeoutSec 180
  Add-Content $log "$(Get-Date -Format s) $Path $($r.StatusCode)"
} catch {
  Add-Content $log "$(Get-Date -Format s) $Path FAILED $($_.Exception.Message)"
  exit 1
}
```

### 2. The tasks

Vercel's schedules are in **UTC**; Task Scheduler uses the PC's local time. The hourly jobs only need their order and spacing (the minutes are kept). The weekly ones are converted below for **India (UTC+5:30)**; on another time zone, convert them yourself.

| Job | Vercel (UTC) | Task Scheduler (local, IST) |
|---|---|---|
| `/api/cron/ingest` | every hour at :00 | every hour at :00 |
| `/api/cron/classify` | every hour at :10 | every hour at :10 |
| `/api/cron/write` | every hour at :20 | every hour at :20 |
| `/api/cron/image` | every hour at :35 | every hour at :35 |
| `/api/cron/factcheck` | every hour at :45 | every hour at :45 |
| `/api/cron/digest-draft` | Mon 03:00 | Mon 08:30 |
| `/api/cron/digest-send` | Mon 05:30 | Mon 11:00 |
| `/api/cron/cleanup?apply=true` | Sun 02:00 | Sun 07:30 |

Run as the service account, whether or not anyone is logged on (elevated PowerShell):

```powershell
$user = ".\svc-newsroom"; $pass = "<the account's password>"
$ps = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
function Add-NewsroomTask($name, $path, $trigger) {
  $action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File D:\newsroom-cron\call.ps1 -Path `"$path`""
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew -StartWhenAvailable
  Register-ScheduledTask -TaskPath "\Newsroom\" -TaskName $name -Action $action -Trigger $trigger -Settings $settings -User $user -Password $pass -RunLevel Limited -Force | Out-Null
}
function Hourly($minute) { New-ScheduledTaskTrigger -Once -At ([datetime]::Today.AddMinutes($minute)) -RepetitionInterval (New-TimeSpan -Hours 1) }

Add-NewsroomTask "ingest"       "/api/cron/ingest"    (Hourly 0)
Add-NewsroomTask "classify"     "/api/cron/classify"  (Hourly 10)
Add-NewsroomTask "write"        "/api/cron/write"     (Hourly 20)
Add-NewsroomTask "image"        "/api/cron/image"     (Hourly 35)
Add-NewsroomTask "factcheck"    "/api/cron/factcheck" (Hourly 45)
Add-NewsroomTask "digest-draft" "/api/cron/digest-draft" (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At "08:30")
Add-NewsroomTask "digest-send"  "/api/cron/digest-send"  (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At "11:00")
Add-NewsroomTask "cleanup"      "/api/cron/cleanup?apply=true" (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At "07:30")
```

- The account needs **Log on as a batch job** (`secpol.msc`, same place as above) for "run whether user is logged on or not".
- `-Once ... -RepetitionInterval` without a duration repeats indefinitely. Check one in `taskschd.msc` > Newsroom > the task > Triggers: "Repeat task every 1 hour, for a duration of Indefinitely".
- The `maxDuration = 60` of the routes is a Vercel limit and does not apply here; `STAGE_TIME_BUDGET_MS` still ends each stage on time.
- Test one by hand: `Start-ScheduledTask -TaskPath "\Newsroom\" -TaskName ingest`, then `Get-Content D:\newsroom-logs\cron.log -Tail 5`. Expect `200`. A `401` means the secret in the script does not match the one the server loaded (restart the service after changing `.env.local`).
- **Remove the Vercel crons** (or the GitHub workflow, if you use one) if the same Supabase project is also served from there, or every job runs twice.

## Check it works

1. On the server PC: `http://localhost:3000` loads; `http://localhost:3000/admin/login` shows the sign-in form; sign in.
2. From another PC: `http://<pc-name>:3000` loads, an article opens, and the Copy button on a code block works (or says "Copy failed", see above).
3. From another PC: `http://<pc-name>:3000/admin` answers **404** (with the default policy).
4. From another PC: reader sign-in (email, code), a like, a comment, sign out.
5. If Turnstile is on: send a test story on `/submit` from another PC.

## Later: https

Plain http is a stop-gap. When IT can issue a certificate for `<pc-name>` from the company CA (trusted by the company's browsers), put a TLS reverse proxy in front (IIS with ARR, or Caddy), run the app with plain `next start -H 127.0.0.1` behind it, and have the proxy set `X-Forwarded-Proto: https` and `X-Forwarded-For`. Do **not** use `start:lan` behind a proxy: it throws away the proxy's headers by design, so cookies would not get `Secure` and every request would look like it came from the proxy. With https, every cookie gets `Secure`, the clipboard API works, HSTS applies, and `/admin` can be opened to the LAN safely (the localhost rule is then not needed).
