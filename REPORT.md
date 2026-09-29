# Mostaql Monitor: production incident report & fix (v3.1.x → v3.2.0)

Prepared 2026-09-29. The repository was inspected at commit `7f8af17` (2026-06-11), which is the latest commit on GitHub.

## A. Executive summary

The Telegram bot didn't break. **The scraper stopped getting projects from Mostaql on 24 Aug 2026 at about 18:41 UTC.** Since then every check has failed, and the code hid those failures behind `success:true, scanned:0`.

What happens on each run: the plain HTTP request to Mostaql is refused almost immediately. The code then falls back to Playwright, which crashes because Chromium was never installed on Hostinger. That crash is caught, turned into zeros, and reported as success.

Mostaql itself hasn't changed. I fetched the live page today from a normal browser: the static HTML still contains the 25 `tr.project-row` rows with the same selectors, so no browser is needed. The strongest remaining explanation is that Mostaql refuses requests from Hostinger's server IP. Two independent datacenter fetchers I tried were refused with HTTP 403, even for `robots.txt`.

v3.2.0 does the following:

* Reports every failure explicitly (`SCRAPE_BLOCKED` / `SCRAPE_FAILED` / `SCRAPE_PARSE_FAILED` / `TELEGRAM_FAILED` …), including the exact HTTP status.
* Adds working fallback routes that don't need a browser: a free Cloudflare Worker relay, or any HTTP proxy or scraping API.
* Removes Playwright from production.
* Keeps a failed notification queued and retries it instead of losing it.
* Prevents overlapping cron runs.
* Sends you a Telegram alert when scraping breaks and another when it recovers.
* Fixes several secret-exposure and correctness bugs.

## B. Root cause

### Correction to the brief
The live `/api/status`, fetched 2026-09-29 09:50 UTC, reports `"last_successful_scrape":"2026-08-24T18:41:05Z"`, with `last_stats: {scraped: 25, matched: 0}` at that same moment. It does **not** say 24 September. Scraping and notifications both stopped on **24 August**, 34 minutes apart. That makes it a single incident: no scrapes means no notifications.

### 1. Confirmed root causes
| # | Finding | Proof |
|---|---|---|
| R1 | Every run gets 0 projects from the Axios path, and it fails **fast** | `last_scheduler_run 09:50:09.946Z` → error recorded `09:50:10.133Z`: **187 ms** for Axios plus the Playwright attempt. A timeout would take 20 s (`timeout: 20000`), so Axios got an immediate non-200 response or an unusable page. Every one of those cases hits `return []` in `fetchWithAxios` (lines 59-73 of the old file). |
| R2 | The Playwright fallback can never work on Hostinger | Error: `Executable doesn't exist at …/.cache/ms-playwright/chromium_headless_shell-1223/…`. `package.json` installs the `playwright` package (`^1.44.0`, resolved to 1.60+), but nothing downloads its browser, and every Playwright upgrade changes the browser revision. Shared hosting also lacks Chromium's system libraries, and you can't install them without root. |
| R3 | The failure is converted into `success:true, scanned:0` | `chromium.launch()` sits **outside** the try block in `fetchWithPlaywright` → the error propagates to the `catch` in `MonitoringJob.runCheck` → `markRunError()` + `return {scanned:0,…}` → `SettingsController` does `res.json({ success: true, ...result })`. cron-job.org sees HTTP 200. |
| R4 | Mostaql's markup is **not** the cause | I fetched the raw server HTML (no JavaScript) from a residential browser: HTTP 200, 157 KB, **25 `tr.project-row`**, `h2.mrg--bt-reset a[href*="/project/"]`, `p.project__brief a.details-url` and `<time datetime="2026-09-29 09:40:06">` (UTC) are all present. The old parser parses this correctly. |

### Most likely underlying trigger (high confidence, not yet proven from Hostinger's own IP)
Mostaql refuses requests coming from Hostinger's IP. Mostaql served normal HTML to a residential browser, but two independent datacenter fetchers got HTTP 403, including for `/robots.txt`. The Hostinger server had been requesting the listing once a minute with a fixed Chrome 124 User-Agent for months, which is a typical trigger for IP blocking. **v3.2 records the exact HTTP status in `scrape.attempts[].http_status`**, so the first `run-check` after deploying settles this.

### 2. Secondary bugs (confirmed in code)
1. **No run lock.** `POST /run-check` does `new MonitoringJob()` per request, and `isRunning` is per instance, so two cron calls could run in parallel and send duplicates.
2. **Failed notifications are lost forever.** The project is saved as `matched` *before* the Telegram send. If the send fails, `exists()` is true on every later run and the project is never retried. This happened throughout the old "Unauthorized" period.
3. **Telegram Markdown without escaping.** `parse_mode:'Markdown'` with raw titles and descriptions: any `_ * [ \`` in a title makes Telegram reject the message with 400 "can't parse entities".
4. **A database read error is treated as "new project".** `try { exists } catch { /* ignore */ }` → if the DB breaks, every project looks new, which risks a flood of duplicates.
5. **Project age parsed in the server's local timezone.** `new Date("2026-09-29 09:40:06")` gives the wrong age on any host not running in UTC.
6. **Stale diagnostics.** `last_scheduler_error` is never cleared, and `/api/status` has no current-health field.
7. **Secrets.** The bot token was copied in plain text into the DB `settings` table. Its prefix was exposed by `/api/status` and `GET /api/settings`, and the chat ID was logged. `PUT /api/settings`, `toggle-monitoring`, `test-telegram` and `run-check` were public, so anyone could pause monitoring or spam your Telegram.
8. **JSON store.** Writes weren't atomic, a corrupt file was silently replaced with empty state (losing dedupe history), and the SQL emulation for `UPDATE … classification='skipped_old'` wrote the reason text into `classification`.
9. **Arabic spelling variants missed matches.** "منصة سله" didn't match "سلة", and "انشاء" didn't match "إنشاء". One of today's live projects, «انشاء متجر على منصة سله», would have been missed.
10. **Dashboard path.** `app.ts` served `./public`, but Vite builds to `dist/public`.

### 3. Deployment problems
* `"postinstall": "npx tsc … || true"` hides compile errors, so a failed build leaves an old `dist/` running. This is one way GitHub and Hostinger can drift apart. The live `/api/status` fields (`token_preview`, `last_stats`, `process_start_time`) match commit `7f8af17`, so production appears to run the latest GitHub code.
* Playwright's Chromium was never provisioned, and can't be reliably provisioned on Hostinger's shared Node hosting.
* `better-sqlite3@9` is a native module and may not build for Node 22 on Hostinger, in which case the app silently uses the JSON store. v3.2 upgrades it to `^12` (prebuilt binaries for Node 22) and shows `database.backend` in `/api/status`.
* `DB_PATH=./data/…` lives inside the app folder, which may be wiped on a full redeploy.

### 4. Potential risks
* The Cloudflare Worker's IPs could also be refused. If so, a paid proxy or scraping API is the fallback. Both are supported through env vars alone.
* Polling Mostaql every 60 s from one IP may be what triggered the block. After a block, v3.2 pauses direct requests for 10 minutes.
* The JSON-store lock only works within one process. With SQLite the lock works across processes.

## C. Corrected system flow

```
cron-job.org ──POST /api/settings/run-check──▶ requireAdmin (only if ADMIN_TOKEN is set)
  └▶ monitoringJob (process singleton)
       ├─ in-process guard + DB lease lock (lock:monitoring_run, TTL 240 s) → SKIPPED_ALREADY_RUNNING
       ├─ DB not ready → ERROR (never treats projects as new)
       ├─ monitoring_active=false → PAUSED
       └▶ MostaqlScraperService.fetchLatestProjects()
            transports: direct → relay (SCRAPER_RELAY_URL) → proxy (SCRAPER_PROXY_URL) → [playwright, opt-in]
            each response is classified:
              401/403/429/challenge → SCRAPE_BLOCKED (direct then cools down 10 min)
              timeout/network/5xx/non-HTML → SCRAPE_FAILED
              200 but rows unparseable/missing → SCRAPE_PARSE_FAILED
              recognised empty listing → SCRAPE_EMPTY
              ≥1 project → SCRAPE_SUCCESS (posted_at normalised to UTC ISO)
       ▼ (only on SUCCESS/EMPTY)
       new-project detection: projects.project_id (numeric Mostaql ID, UNIQUE)
       KeywordMatcher (title, Arabic-normalised)
         no match → classification=no_match
         match, older than NOTIFICATION_MAX_AGE_MINUTES → skipped_old / notify_status=skipped
         match, fresh → INSERT notify_status=pending → Telegram (HTML, escaped)
              ok → notify_status=sent, sent_at=now
              fail → notify_status=failed, attempts+1, last_notify_error (no secrets)
       retry queue: matched rows pending/failed, < NOTIFY_MAX_ATTEMPTS, created within NOTIFY_RETRY_WINDOW_MINUTES
       run status: SUCCESS | SCRAPE_EMPTY | TELEGRAM_FAILED | SCRAPE_* | SKIPPED_* | PAUSED | ERROR
       state: last_run_result, last_successful_scrape, last_telegram_notification, errors (settings table)
       health alert: Telegram message after ALERT_AFTER_MINUTES of failures, plus a recovery message
```

## D. Files changed

| File | Why |
|---|---|
| `src/services/MostaqlScraperService.ts` | Rewritten around typed `ScrapeResult`: failure classification, direct/relay/proxy transports, block cooldown, opt-in and guarded Playwright, UTC timestamps, no silent `[]` |
| `src/jobs/MonitoringJob.ts` | Singleton plus cross-process lock, explicit run statuses, pending→sent/failed notification state, retry queue, health alerts, DB-failure safety, JSON-safe re-evaluate |
| `src/services/TelegramService.ts` | Env-only credentials, HTML parse mode with escaping, 429 retry, clear 401/403/400 errors, no token in logs, returns a result instead of writing to the DB |
| `src/controllers/SettingsController.ts` | Uses the singleton job, returns the explicit status (`?strict=1` → 5xx), admin protection, settings whitelist, credentials hidden |
| `src/database/Database.ts` | Additive migration (`posted_at`, `notify_status`, `notify_attempts`, `last_notify_error`), native notification-state/lock/kv methods for both backends, atomic and corruption-safe JSON store, secret cleanup, retention |
| `src/repositories/ProjectRepository.ts` | New state methods; `exists()` no longer swallowed |
| `src/services/KeywordMatcherService.ts` | Arabic normalisation (ة/ه, أ/إ/آ/ا, ى/ي, tatweel, diacritics) |
| `src/utils/projectAge.ts` | `parseUtc()`: Mostaql and SQLite timestamps parsed as UTC |
| `src/utils/logger.ts` | Every log line is redacted; `logToDb` uses the new API |
| `src/app.ts` | `/api/status` adds `healthy`, `version`, DB backend, scraper transports, last run, current-error flag; token prefix removed; dashboard path fixed |
| `src/index.ts` | Singleton job, version from package.json, no token/chat-ID logging |
| `src/config/AppConfig.ts` | New typed settings (scraper, alerts, retry, lock, admin) |
| `src/modules/types.ts` | `ScrapeResult`, `RunResult`, status enums, new record fields |
| `src/middleware/ErrorHandler.ts` | Redacted error output with explicit `status:"ERROR"` |
| `src/controllers/LogsController.ts` | `DELETE /api/logs` requires admin |
| `package.json` / `package-lock.json` | v3.2.0; see §H |
| `.env.example` | All variables documented, placeholders only |
| `Dockerfile` | Node 22; the build no longer relies on `|| true`; dashboard path fixed |
| `setup.bat` | Chromium step labelled optional |

## F. New files
* `src/utils/redact.ts`: secret scrubbing for logs, DB and API errors
* `src/middleware/adminAuth.ts`: optional `ADMIN_TOKEN` guard, compared in constant time
* `relay/cloudflare-worker.js`: free relay restricted to mostaql.com, with a shared secret
* `DEPLOY-HOSTINGER.md`: deployment, verification and rollback steps

## G. Removed files
None. Playwright is no longer a production dependency (see §H), but its opt-in code path is kept for local use.

## H. Dependencies
* **Added:** `https-proxy-agent@^7.0.6` (pure JS; only used when `SCRAPER_PROXY_URL` is set)
* **Moved:** `playwright` from `dependencies` to `devDependencies` (`^1.55.0`). Production doesn't need it, because Mostaql's HTML is static.
* **Updated:** `better-sqlite3` `^9.4.0` → `^12.2.0` (prebuilt binaries for Node 20/22; still optional, with automatic JSON fallback), `@types/better-sqlite3` → `^7.6.13`, `axios` range → `^1.12.0` (the lock already had 1.17.0)
* **Scripts:** `postinstall`/`build` now run `tsc` without `|| true`, so a compile error fails the deploy visibly.
* **Engines:** `node >=20`
* **package-lock.json:** regenerated and included in the zip. Commit it as is.

## I. Environment variables
See `.env.example` for the full list. Minimum for production:
```
TELEGRAM_BOT_TOKEN=<your-bot-token>
TELEGRAM_CHAT_ID=<your-chat-id>
SCHEDULER_MODE=external
NODE_ENV=production
NOTIFICATION_MAX_AGE_MINUTES=30
ADMIN_TOKEN=<long-random-string>             # recommended; then add the header in cron-job.org
SCRAPER_RELAY_URL=https://<worker>.workers.dev/   # only if direct is blocked
SCRAPER_RELAY_SECRET=<random-string>              # only with the relay
```

## J/K/L. Deployment, verification, rollback
See `DEPLOY-HOSTINGER.md` (included below and in the zip).

## Test evidence
An offline harness stubs Mostaql and Telegram, runs against the compiled `dist/`, and was executed on **both** storage backends (SQLite and JSON fallback):

| Test | Result |
|---|---|
| T1 projects returned → scanned 25, `SUCCESS` | PASS |
| T2 new project detected (newCount 1), repeat run → newCount 0 | PASS |
| T3 fresh match → 1 Telegram message, HTML-escaped, `notify_status=sent` | PASS |
| T3b match older than 30 min → `skipped_old`, no message | PASS |
| T4 no match → no message | PASS |
| T5 timeout → `SCRAPE_FAILED`, `success:false` | PASS |
| T6 403 → `SCRAPE_BLOCKED` (http_status 403), next run `SKIPPED_COOLDOWN` without contacting Mostaql; 429 → BLOCKED; 200 challenge page → BLOCKED | PASS |
| T7 markup change → `SCRAPE_PARSE_FAILED` (rows without links / no rows); JSON body → `SCRAPE_FAILED`; genuine empty page → `SCRAPE_EMPTY` | PASS |
| T8 Playwright not attempted by default; with `PLAYWRIGHT_FALLBACK=true` and no browser → explicit "Chromium not installed" attempt | PASS |
| T9 Telegram 400 → `TELEGRAM_FAILED`, row `failed` with `sent_at NULL` → next run retries → sent exactly once → no further sends | PASS |
| T10 two simultaneous run-checks → one `SUCCESS` + one `SKIPPED_ALREADY_RUNNING`, one message; lock held by another worker → skipped; expired lock taken over | PASS |
| T11 new process on the same DB → state intact, no re-send | PASS |
| T12 Telegram 401 → "401 Unauthorized — TELEGRAM_BOT_TOKEN is invalid or revoked"; token absent from every log line, DB row and error | PASS |
| Relay: direct 403 → relay SUCCESS; direct skipped during cooldown; outage alert sent once; recovery message | PASS |
| Migration of a v3.1 SQLite DB: columns added, token row removed, old unsent matches **not** re-sent | PASS |
| A verbatim live Mostaql row (2026-09-29) parsed correctly; «انشاء متجر على منصة سله» now matches «سلة» | PASS |
| HTTP end-to-end: 401 without admin token, JSON status with token, `?strict=1` → 503 | PASS |


---

## Mostaql Monitor v3.2 — Hostinger deployment, verification & rollback

## 1. Push the code to GitHub

1. Extract the zip over your local clone of `mostaql-monitor` (overwrite files; don't touch `.git`).
2. Commit and push:
   ```
   git add -A
   git commit -m "v3.2.0: visible scraper failures, relay/proxy transports, notification retry, run lock"
   git push origin main
   ```
   `package-lock.json` is already regenerated in the zip, so you don't need to run `npm install` locally first.

## 2. Hostinger (hPanel → Websites → your Node.js app)

| Setting | Value |
|---|---|
| Node.js version | 22.x |
| Install command | `npm install` (the `postinstall` step compiles TypeScript, and a compile error now **fails the deploy** instead of leaving an old `dist/` running) |
| Build command | `npm run build` (harmless if it runs twice) |
| Start command / entry | `npm start` → `dist/index.js` |

Redeploy from GitHub (or press **Redeploy**), then **restart** the app after you change any environment variable.

## 3. Environment variables

Required (these already exist):
```
TELEGRAM_BOT_TOKEN=<your-bot-token>
TELEGRAM_CHAT_ID=<your-chat-id>
SCHEDULER_MODE=external
NODE_ENV=production
NOTIFICATION_MAX_AGE_MINUTES=30
```
Keep your current `DB_PATH` for this deploy so the list of projects you've already seen is preserved.

Recommended:
```
ADMIN_TOKEN=<long-random-string>          # protects run-check/test-telegram/settings
ALERT_AFTER_MINUTES=15                     # Telegram alert when scraping breaks
```

Needed **only if** the first run-check reports `SCRAPE_BLOCKED` (see §5):
```
SCRAPER_RELAY_URL=https://<worker-name>.<subdomain>.workers.dev/
SCRAPER_RELAY_SECRET=<same value as RELAY_SECRET in the Worker>
## or, alternatively
SCRAPER_PROXY_URL=http://<user>:<pass>@<host>:<port>
```

Do **not** set `PLAYWRIGHT_FALLBACK` on Hostinger.

## 4. cron-job.org

* The URL stays the same: `POST https://cornflowerblue-curlew-939552.hostingersite.com/api/settings/run-check`
* If you set `ADMIN_TOKEN`, add this request header in the job's **Advanced** tab:
  `Authorization: Bearer <ADMIN_TOKEN>`
* The endpoint keeps returning HTTP 200 even when a check fails, so cron-job.org won't auto-disable the job during a Mostaql outage. The body's `status` and `success` fields tell you what actually happened, and the app sends a Telegram alert.
  If you'd rather have cron-job.org flag failures itself, use `.../run-check?strict=1`. It returns 502/503 on failure, but cron-job.org may disable a job that keeps failing.

## 5. Verification (Windows PowerShell: use `curl.exe`)

```
curl.exe https://cornflowerblue-curlew-939552.hostingersite.com/health
```
→ `{"status":"ok","version":"3.2.0",...}`. **The version must be 3.2.0**, which proves the new code is running.

```
curl.exe -X POST -H "Authorization: Bearer <ADMIN_TOKEN>" https://cornflowerblue-curlew-939552.hostingersite.com/api/settings/run-check
```
Read `status` and `scrape.attempts[0]`:

| Result | Meaning / action |
|---|---|
| `"status":"SUCCESS"`, `"scanned":25` | Scraping works. Done. |
| `"status":"SCRAPE_BLOCKED"`, `"http_status":403` (or 429) | Mostaql refuses Hostinger's IP. Deploy the relay (§6), then run this again. |
| `"status":"SKIPPED_COOLDOWN"` | The previous run was blocked, so direct requests are paused for 10 minutes. Configure the relay, restart, and run again. |
| `"status":"SCRAPE_FAILED"`, error `timeout ...` | Network problem between Hostinger and Mostaql. |
| `"status":"SCRAPE_PARSE_FAILED"` | Mostaql changed its HTML. Send me `page_title` and `rows_found`. |
| `"status":"TELEGRAM_FAILED"` | The scrape worked, but a Telegram send failed. See `/api/status → telegram.last_error`. The notification will be retried. |

```
curl.exe -X POST -H "Authorization: Bearer <ADMIN_TOKEN>" https://cornflowerblue-curlew-939552.hostingersite.com/api/settings/test-telegram
```
→ `{"success":true,"status":"SUCCESS","info":"@yourbot — test message delivered"}`, and the message shows up in Telegram.
A bad token gives `401 Unauthorized — TELEGRAM_BOT_TOKEN is invalid or revoked` (the token itself is never shown).

```
curl.exe https://cornflowerblue-curlew-939552.hostingersite.com/api/status
```
Check these fields:
* `healthy: true`
* `database.backend` is `sqlite` or `json`
* `scheduler.last_run.status` is `SUCCESS`
* `scheduler.minutes_since_successful_scrape` is at most 2 once cron is running
* `scraper.relay_configured` is `true`/`false` as you configured it

**Cron:** in cron-job.org → the job → History, the response body of recent runs should show `"status":"SUCCESS"`.

## 6. Relay (only if Hostinger is blocked)

1. Go to dash.cloudflare.com → Workers & Pages → Create Worker, paste `relay/cloudflare-worker.js`, and deploy.
2. In the Worker's Settings → Variables and Secrets, add a secret named `RELAY_SECRET` with a random string.
3. Test it from your PC:
   `curl.exe -H "X-Relay-Secret: <secret>" "https://<worker>.workers.dev/?url=https%3A%2F%2Fmostaql.com%2Fprojects"`
   It should return HTML containing `project-row`. If Cloudflare's IPs are refused too (HTTP 403), use a proxy or scraping API instead:
   `SCRAPER_RELAY_URL=https://api.scraperapi.com/?api_key=<KEY>&url={url}` or `SCRAPER_PROXY_URL=...`
4. Set `SCRAPER_RELAY_URL` and `SCRAPER_RELAY_SECRET` on Hostinger, restart, and run the check again. It should report `"transport":"relay"`.

## 7. Rollback

1. In GitHub: `git revert <v3.2 commit>` then `git push`. Or in Hostinger, redeploy commit `7f8af17`.
2. Restart the app. The database changes are additive (new columns only), so v3.1 runs on the migrated database unchanged.
   v3.1 reads Telegram credentials from env first, so removing the old DB copy of the token doesn't affect it.
3. The new env vars (`ADMIN_TOKEN`, `SCRAPER_*`, `ALERT_*`) are ignored by v3.1. If you added a header to cron-job.org, you can leave it there; v3.1 ignores it too.

---

## E + F. Complete contents of every changed and new file

### `package.json`

````json
{
  "name": "mostaql-monitor",
  "version": "3.2.0",
  "description": "Mostaql Front-End Project Monitor",
  "main": "dist/index.js",
  "engines": {
    "node": ">=20.0.0"
  },
  "scripts": {
    "dev": "ts-node-dev --respawn --transpile-only --exit-child src/index.ts",
    "build": "tsc --project tsconfig.json",
    "postinstall": "tsc --project tsconfig.json",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "axios": "^1.12.0",
    "cheerio": "^1.0.0-rc.12",
    "cors": "^2.8.5",
    "dotenv": "^16.3.1",
    "express": "^4.18.2",
    "https-proxy-agent": "^7.0.6",
    "node-cron": "^3.0.3",
    "typescript": "^5.3.3",
    "winston": "^3.11.0",
    "winston-daily-rotate-file": "^4.7.1",
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.21",
    "@types/node": "^20.11.0",
    "@types/node-cron": "^3.0.11"
  },
  "optionalDependencies": {
    "better-sqlite3": "^12.2.0",
    "@types/better-sqlite3": "^7.6.13"
  },
  "devDependencies": {
    "playwright": "^1.55.0",
    "ts-node-dev": "^2.0.0"
  }
}
````

### `.env.example`

````text
# ═══════════════════════════════════════
#  Mostaql Monitor v3.2 — Environment Variables
#  (placeholders only — never commit real values)
# ═══════════════════════════════════════

# ── Server ──────────────────────────────
PORT=3001
NODE_ENV=production

# ── Telegram (REQUIRED, env-only) ───────
TELEGRAM_BOT_TOKEN=<your-bot-token>
TELEGRAM_CHAT_ID=<your-chat-id>
# TELEGRAM_TIMEOUT_MS=15000

# ── Scheduling ──────────────────────────
# external = cron-job.org calls POST /api/settings/run-check
SCHEDULER_MODE=external
CHECK_INTERVAL_SECONDS=60
# Run one check when the process starts (default true)
# RUN_CHECK_ON_STARTUP=true

# ── Security (recommended) ──────────────
# When set, run-check / test-telegram / settings changes require
#   Authorization: Bearer <ADMIN_TOKEN>   (or ?token=<ADMIN_TOKEN>)
# ADMIN_TOKEN=<long-random-string>

# ── Notifications ───────────────────────
NOTIFICATION_MAX_AGE_MINUTES=30
# NOTIFY_MAX_ATTEMPTS=5
# NOTIFY_RETRY_WINDOW_MINUTES=180
# Telegram health alert when scraping has failed for this long (0 = off)
# ALERT_AFTER_MINUTES=15
# ALERT_REPEAT_HOURS=6

# ── Scraper ─────────────────────────────
# SCRAPER_TIMEOUT_MS=20000
# SCRAPER_BLOCK_COOLDOWN_MINUTES=10
# Fallback transports, used when Mostaql blocks this server's IP:
# 1) Relay (Cloudflare Worker from relay/cloudflare-worker.js, or a scraping
#    API). {url} is replaced by the encoded Mostaql URL; if absent, ?url= is appended.
# SCRAPER_RELAY_URL=https://mostaql-relay.<your-subdomain>.workers.dev/
# SCRAPER_RELAY_SECRET=<same-value-as-RELAY_SECRET-in-the-worker>
# 2) HTTP(S) proxy
# SCRAPER_PROXY_URL=http://<user>:<pass>@<host>:<port>
# 3) Playwright — local machines only; needs `npx playwright install chromium`
# PLAYWRIGHT_FALLBACK=false

# ── Storage ─────────────────────────────
# Use a path OUTSIDE the deployed app folder so redeploys keep state
DB_PATH=./data/mostaql.db
# PROJECT_RETENTION_DAYS=90

# ── Logging ─────────────────────────────
LOG_LEVEL=info
LOG_DIR=./logs
````

### `Dockerfile`

````dockerfile
FROM node:22-slim AS base
WORKDIR /app

# ── Backend: install prod deps + compile (postinstall runs tsc) ──
FROM base AS backend
COPY package.json package-lock.json* tsconfig.json ./
COPY src/ ./src/
RUN npm ci --omit=dev
COPY config/ ./config/

# ── Dashboard build ────────────────────────────────────────────
FROM node:22-slim AS dashboard-build
WORKDIR /app/dashboard
COPY dashboard/package.json dashboard/package-lock.json* ./
RUN npm install
COPY dashboard/ ./
RUN npm run build

# ── Final image ────────────────────────────────────────────────
FROM node:22-slim AS runner
WORKDIR /app

COPY --from=backend /app/package.json ./package.json
COPY --from=backend /app/node_modules ./node_modules
COPY --from=backend /app/dist ./dist
COPY --from=backend /app/config ./config
COPY --from=dashboard-build /app/dist/public ./dist/public

RUN mkdir -p data logs

ENV NODE_ENV=production
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "require('http').get('http://localhost:3001/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
````

### `src/modules/types.ts`

````typescript
export interface ScrapedProject {
  project_id: string;
  title: string;
  url: string;
  budget: string;
  description: string;
  skills: string[];
  /** ISO-8601 UTC timestamp (normalised by the scraper), if Mostaql exposed one. */
  posted_at?: string;
}

export interface ProjectRecord {
  id: number;
  project_id: string;
  title: string;
  url: string;
  budget: string;
  description: string;
  skills: string;
  classification: string;
  reason: string;
  matched_keywords: string;
  posted_at: string | null;
  notify_status: NotifyStatus | null;
  notify_attempts: number;
  last_notify_error: string | null;
  created_at: string;
  sent_at: string | null;
}

/** Per-project Telegram delivery state. */
export type NotifyStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export interface ProjectFilter {
  search?: string;
  classification?: string;
  page?: number;
  limit?: number;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ── Scraper result model ─────────────────────────────────────────
export type ScrapeStatus =
  | 'SCRAPE_SUCCESS'       // ≥1 project parsed
  | 'SCRAPE_EMPTY'         // page fetched and recognised, genuinely 0 projects
  | 'SCRAPE_FAILED'        // network error, timeout, 5xx, unexpected response
  | 'SCRAPE_BLOCKED'       // 401/403/429/challenge page — Mostaql refused us
  | 'SCRAPE_PARSE_FAILED'; // 200 HTML but project rows could not be parsed

export type ScrapeTransport = 'direct' | 'relay' | 'proxy' | 'playwright';

export interface ScrapeAttempt {
  transport: ScrapeTransport;
  status: ScrapeStatus;
  http_status?: number;
  duration_ms: number;
  bytes?: number;
  rows_found?: number;
  page_title?: string;
  error?: string;
}

export interface ScrapeResult {
  status: ScrapeStatus;
  projects: ScrapedProject[];
  transport?: ScrapeTransport;
  attempts: ScrapeAttempt[];
  error?: string;
  /** Set when no transport was attempted because direct is cooling down after a block. */
  cooldown_until?: string;
}

// ── Monitoring run result model ─────────────────────────────────
export type RunStatus =
  | 'SUCCESS'                  // scrape OK, every required notification delivered
  | 'SCRAPE_EMPTY'
  | 'SCRAPE_FAILED'
  | 'SCRAPE_BLOCKED'
  | 'SCRAPE_PARSE_FAILED'
  | 'TELEGRAM_FAILED'          // scrape OK, ≥1 notification failed (will be retried)
  | 'SKIPPED_ALREADY_RUNNING'  // another run holds the lock
  | 'SKIPPED_COOLDOWN'         // backing off after Mostaql blocked us
  | 'PAUSED'                   // monitoring_active = false
  | 'ERROR';                   // unexpected internal error

export interface RunResult {
  success: boolean;
  status: RunStatus;
  triggered_by: string;
  scanned: number;
  newCount: number;
  matched: number;
  notified: number;
  notifyFailed: number;
  retried: number;
  skippedOld: number;
  duration_ms: number;
  scrape?: {
    status: ScrapeStatus;
    transport?: ScrapeTransport;
    attempts: ScrapeAttempt[];
  };
  error?: string;
  message?: string;
}
````

### `src/config/AppConfig.ts`

````typescript
import path from 'path';

// ──────────────────────────────────────────────────────────────
// AppConfig — single source of truth for all configuration.
//
// Telegram credentials come ONLY from environment variables.
// They are never written to the database and never logged.
// ──────────────────────────────────────────────────────────────

function int(name: string, def: number, min = 0): number {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v >= min ? v : def;
}

function bool(name: string, def: boolean): boolean {
  const v = (process.env[name] || '').trim().toLowerCase();
  if (!v) return def;
  return ['1', 'true', 'yes', 'on'].includes(v);
}

function readVersion(): string {
  try {
    // dist/config/AppConfig.js → ../../package.json
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(path.resolve(__dirname, '..', '..', 'package.json')).version || 'unknown';
  } catch { return 'unknown'; }
}

export const AppConfig = {
  version: readVersion(),
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // Database — must be a writable path that survives redeploys
  dbPath: process.env.DB_PATH || './data/mostaql.db',

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
  logDir: process.env.LOG_DIR || './logs',

  // Optional shared secret protecting run-check / settings mutations
  adminToken: process.env.ADMIN_TOKEN || '',

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
    timeoutMs: int('TELEGRAM_TIMEOUT_MS', 15000, 1000),
  },

  monitoring: {
    schedulerMode: (process.env.SCHEDULER_MODE === 'external' ? 'external' : 'internal') as 'internal' | 'external',
    checkIntervalSeconds: int('CHECK_INTERVAL_SECONDS', 60, 10),
    runOnStartup: bool('RUN_CHECK_ON_STARTUP', true),
    // Max duration a run may hold the lock before it is considered dead
    runLockTtlSeconds: int('RUN_LOCK_TTL_SECONDS', 240, 30),
    // Failed notifications are retried on later runs within this window
    notifyMaxAttempts: int('NOTIFY_MAX_ATTEMPTS', 5, 1),
    notifyRetryWindowMinutes: int('NOTIFY_RETRY_WINDOW_MINUTES', 180, 5),
    // Telegram health alert once scraping has been failing this long (0 = disabled)
    alertAfterMinutes: int('ALERT_AFTER_MINUTES', 15, 0),
    alertRepeatHours: int('ALERT_REPEAT_HOURS', 6, 1),
  },

  scraper: {
    targetUrl: process.env.MOSTAQL_URL || 'https://mostaql.com/projects?category=development&budget_max=10000&sort=latest',
    timeoutMs: int('SCRAPER_TIMEOUT_MS', 20000, 2000),
    userAgent: process.env.SCRAPER_USER_AGENT ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    // Relay: Cloudflare Worker / scraping API. Use {url} as placeholder
    // for the URL-encoded Mostaql URL, or omit it to have ?url= appended.
    relayUrl: process.env.SCRAPER_RELAY_URL || '',
    relaySecret: process.env.SCRAPER_RELAY_SECRET || '',
    // HTTP(S) proxy, e.g. http://user:pass@host:port
    proxyUrl: process.env.SCRAPER_PROXY_URL || '',
    // Skip the direct transport for this long after Mostaql blocks it
    // (only when another transport is configured, or to avoid hammering).
    blockCooldownMinutes: int('SCRAPER_BLOCK_COOLDOWN_MINUTES', 10, 0),
    // Playwright is OFF by default: Mostaql serves project rows in static
    // HTML, and Hostinger shared hosting cannot run Chromium reliably.
    playwrightEnabled: bool('PLAYWRIGHT_FALLBACK', false),
  },

  paths: {
    data: path.resolve(process.cwd(), process.env.DATA_DIR || 'data'),
    logs: path.resolve(process.cwd(), process.env.LOG_DIR || 'logs'),
  },
} as const;
````

### `src/utils/redact.ts`

````typescript
// ──────────────────────────────────────────────────────────────
// Secret redaction — every string that may reach logs, the DB or
// an API response passes through here first.
// ──────────────────────────────────────────────────────────────

const SECRET_ENV_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'ADMIN_TOKEN',
  'SCRAPER_RELAY_SECRET',
  'SCRAPER_PROXY_URL',
  'SCRAPER_RELAY_URL',
];

export function redact(input: unknown): string {
  let s = typeof input === 'string' ? input : safeStringify(input);

  // Telegram bot tokens anywhere (URL form and bare form)
  s = s.replace(/bot\d{5,}:[A-Za-z0-9_-]{20,}/g, 'bot<redacted>');
  s = s.replace(/\b\d{5,}:[A-Za-z0-9_-]{30,}\b/g, '<redacted-token>');

  // Credentials embedded in URLs: scheme://user:pass@host
  s = s.replace(/(\w+:\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1<redacted>@');

  // Common API-key query parameters
  s = s.replace(/([?&](?:api_key|apikey|key|token|secret|access_token)=)[^&\s"']+/gi, '$1<redacted>');

  // Exact values of known secret env vars
  for (const k of SECRET_ENV_KEYS) {
    const v = process.env[k];
    if (v && v.length >= 6) s = s.split(v).join(`<${k}>`);
  }
  return s;
}

/** Short, safe description of an error (never includes request config). */
export function errorMessage(err: any): string {
  if (!err) return 'unknown error';
  const code = err.code ? `${err.code}: ` : '';
  return redact(`${code}${err.message || String(err)}`).slice(0, 500);
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}
````

### `src/utils/logger.ts`

````typescript
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';
import { redact } from './redact';

const logDir = process.env.LOG_DIR || './logs';
let fileLogging = true;
try {
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
} catch { fileLogging = false; }

// Every log line is scrubbed of secrets before it is written anywhere.
const scrub = winston.format((info) => {
  info.message = redact(info.message);
  return info;
});

const fmt = winston.format.combine(
  scrub(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message }) =>
    `[${timestamp}] ${level.toUpperCase().padEnd(5)}: ${message}`
  )
);

const transports: winston.transport[] = [
  new winston.transports.Console({ format: fmt }),
];

if (fileLogging) {
  try {
    transports.push(
      new DailyRotateFile({
        filename: path.join(logDir, 'app-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        maxFiles: '14d',
        format: winston.format.combine(scrub(), winston.format.timestamp(), winston.format.json()),
      })
    );
  } catch { /* file logging unavailable */ }
}

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports,
});

export function logToDb(level: string, category: string, message: string, meta?: object): void {
  try {
    // Lazy require avoids a circular import (Database imports logger)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Database } = require('../database/Database');
    Database.getInstance().addLog(level, category, redact(message), meta ? JSON.parse(redact(meta)) : undefined);
  } catch { /* non-critical */ }
}
````

### `src/utils/projectAge.ts`

````typescript
import { logger } from './logger';

// ──────────────────────────────────────────────────────────────
// Project age checker
//
// Uses NOTIFICATION_MAX_AGE_MINUTES env var (default: 30).
// Called before every Telegram send to skip old projects.
// ──────────────────────────────────────────────────────────────

export function getMaxAgeMinutes(): number {
  const raw = process.env.NOTIFICATION_MAX_AGE_MINUTES;
  const parsed = raw ? parseInt(raw, 10) : 30;
  return isNaN(parsed) || parsed <= 0 ? 30 : parsed;
}

/**
 * Parse a timestamp as UTC.
 *
 * Mostaql renders `<time datetime="2026-09-29 09:40:06">` in UTC without a
 * zone designator. `new Date("2026-09-29 09:40:06")` would interpret that in
 * the SERVER's local timezone, so a host not running in UTC would compute a
 * wrong age. SQLite `datetime('now')` values have the same shape.
 */
export function parseUtc(value: string | null | undefined): Date | null {
  if (!value) return null;
  const v = value.trim();
  const naive = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/.exec(v);
  const d = naive ? new Date(`${naive[1]}T${naive[2]}Z`) : new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

export interface AgeCheckResult {
  allowed: boolean;      // true = send notification
  ageMinutes: number;    // how old the project is
  maxMinutes: number;    // configured threshold
  reason: string;
}

/**
 * Returns whether a project is fresh enough to notify.
 * If the timestamp is missing/invalid the project is treated as FRESH.
 */
export function checkProjectAge(
  project_id: string,
  title: string,
  posted_at: string | null | undefined
): AgeCheckResult {
  const maxMinutes = getMaxAgeMinutes();

  if (!posted_at) {
    return { allowed: true, ageMinutes: 0, maxMinutes, reason: 'No timestamp available — allowing by default' };
  }

  const postedDate = parseUtc(posted_at);
  if (!postedDate) {
    logger.warn(`Invalid timestamp for project ${project_id}: "${posted_at}" — allowing by default`);
    return { allowed: true, ageMinutes: 0, maxMinutes, reason: `Invalid timestamp "${posted_at}" — allowing by default` };
  }

  const ageMinutes = Math.max(0, Math.round((Date.now() - postedDate.getTime()) / 60000));

  if (ageMinutes > maxMinutes) {
    const msg = `Skipped project because age exceeds ${maxMinutes} minutes — ` +
      `project_id=${project_id}, title="${title.slice(0, 60)}", ` +
      `posted_at=${posted_at}, age=${ageMinutes}min`;
    logger.info(`⏭  ${msg}`);
    return { allowed: false, ageMinutes, maxMinutes, reason: msg };
  }

  return {
    allowed: true,
    ageMinutes,
    maxMinutes,
    reason: `Project is ${ageMinutes} minutes old — within ${maxMinutes} minute limit`,
  };
}
````

### `src/database/Database.ts`

````typescript
import path from 'path';
import fs from 'fs';
import { AppConfig } from '../config/AppConfig';
import { logger } from '../utils/logger';
import { NotifyStatus } from '../modules/types';

// ──────────────────────────────────────────────────────────────
// Database — dual backend
// 1. better-sqlite3 (native, fast, safe across processes)
// 2. JSON file store fallback (zero native deps, single process)
//
// Monitoring-critical operations (dedupe, notification state,
// run lock, key/value state) are implemented natively for BOTH
// backends. The small SQL emulator for the JSON store is kept only
// for the read-only dashboard endpoints.
// ──────────────────────────────────────────────────────────────

let BetterSqlite: any = null;
let betterSqliteLoadError = '';
try { BetterSqlite = require('better-sqlite3'); } catch (e: any) { betterSqliteLoadError = e?.message || String(e); }

export interface NewProjectRow {
  project_id: string;
  title: string;
  url: string;
  budget: string;
  description: string;
  skills: string;
  classification: string;
  reason: string;
  matched_keywords: string;
  posted_at: string | null;
  notify_status: NotifyStatus | null;
}

export interface RetryableProject {
  project_id: string;
  title: string;
  url: string;
  budget: string;
  description: string;
  skills: string;
  matched_keywords: string;
  posted_at: string | null;
  notify_attempts: number;
  created_at: string;
}

const PROJECT_RETENTION_DAYS = Math.max(7, parseInt(process.env.PROJECT_RETENTION_DAYS || '90', 10) || 90);
const SECRET_SETTING_KEYS = ['telegram_bot_token', 'telegram_chat_id'];

// ── JSON fallback store ────────────────────────────────────────
class JsonStore {
  private data: Record<string, any[]> = {
    projects: [], notifications: [], settings: [], system_logs: [],
  };
  readonly filePath: string;
  private saveTimer: NodeJS.Timeout | null = null;
  lastSaveError = '';

  constructor(dbPath: string) {
    this.filePath = dbPath.replace(/\.db$/, '') + '.json';
    this.load();
  }

  private load() {
    if (!fs.existsSync(this.filePath)) return;
    const raw = fs.readFileSync(this.filePath, 'utf8');
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
      this.data = { projects: [], notifications: [], settings: [], system_logs: [], ...parsed };
    } catch (e: any) {
      // Never silently start fresh over a corrupt file — keep it for inspection.
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      try { fs.renameSync(this.filePath, backup); } catch { /* ignore */ }
      logger.error(`JSON store corrupt (${e.message}) — moved to ${backup}, starting with empty state`);
    }
  }

  /** Write synchronously and atomically (tmp file + rename). */
  flush() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    const tmp = `${this.filePath}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.filePath);
      this.lastSaveError = '';
    } catch (e: any) {
      this.lastSaveError = e.message;
      logger.error(`JSON store write failed: ${e.message}`);
    }
  }

  /** Coalesce many writes within one run into a single disk write. */
  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, 300);
  }

  table(name: string): any[] {
    if (!this.data[name]) this.data[name] = [];
    return this.data[name];
  }

  nextId(name: string): number {
    const t = this.table(name);
    let max = 0;
    for (const r of t) if ((r.id || 0) > max) max = r.id;
    return max + 1;
  }
}

// ── Unified Database class ─────────────────────────────────────
export class Database {
  private static instance: Database;
  private sqliteDb: any = null;
  private jsonStore: JsonStore | null = null;
  private useSqlite = false;
  private memLocks = new Map<string, { owner: string; expires: number }>();
  initError = '';

  private constructor() {}

  static getInstance(): Database {
    if (!Database.instance) Database.instance = new Database();
    return Database.instance;
  }

  async initialize(): Promise<void> {
    const dbPath = path.resolve(AppConfig.dbPath);
    const dbDir = path.dirname(dbPath);

    try {
      if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    } catch (e: any) {
      logger.warn(`Cannot create data dir ${dbDir}: ${e.message}`);
    }

    if (BetterSqlite) {
      try {
        this.sqliteDb = new BetterSqlite(dbPath);
        this.sqliteDb.pragma('journal_mode = WAL');
        this.sqliteDb.pragma('busy_timeout = 5000');
        this.createSqliteTables();
        this.migrateSqlite();
        this.useSqlite = true;
        this.cleanupSecretsAndOldRows();
        logger.info(`✅ SQLite initialized: ${dbPath}`);
        return;
      } catch (e: any) {
        this.initError = `SQLite failed: ${e.message}`;
        logger.warn(`SQLite failed (${e.message}), falling back to JSON store`);
        this.sqliteDb = null;
      }
    } else {
      logger.warn(`better-sqlite3 not available (${betterSqliteLoadError.split('\n')[0]}) — using JSON store`);
    }

    this.jsonStore = new JsonStore(dbPath);
    this.migrateJson();
    this.cleanupSecretsAndOldRows();
    this.jsonStore.flush();
    logger.info(`✅ JSON store initialized: ${this.jsonStore.filePath}`);
  }

  backend(): 'sqlite' | 'json' | 'none' {
    return this.useSqlite ? 'sqlite' : this.jsonStore ? 'json' : 'none';
  }

  storagePath(): string | null {
    if (this.useSqlite) return path.resolve(AppConfig.dbPath);
    return this.jsonStore?.filePath ?? null;
  }

  // ── Generic SQL API (dashboard/read endpoints) ─────────────

  run(sql: string, params: any[] = []): void {
    this.assertReady();
    if (this.useSqlite) {
      this.sqliteDb.prepare(sql).run(...params);
    } else {
      this.jsonRun(sql, params);
    }
  }

  queryOne<T = any>(sql: string, params: any[] = []): T | null {
    return this.queryAll<T>(sql, params)[0] ?? null;
  }

  queryAll<T = any>(sql: string, params: any[] = []): T[] {
    this.assertReady();
    if (this.useSqlite) {
      return this.sqliteDb.prepare(sql).all(...params) as T[];
    }
    return this.jsonQuery<T>(sql, params);
  }

  // Legacy shim for any code using getDb()
  getDb(): any {
    if (this.useSqlite) return this.sqliteDb;
    const self = this;
    return {
      prepare: (sql: string) => ({
        run: (...params: any[]) => self.run(sql, params),
        get: (...params: any[]) => self.queryOne(sql, params),
        all: (...params: any[]) => self.queryAll(sql, params),
      }),
    };
  }

  isReady(): boolean {
    return this.useSqlite || this.jsonStore !== null;
  }

  /** Persist pending JSON writes immediately (end of each run). */
  flush(): void {
    if (this.jsonStore) this.jsonStore.flush();
  }

  close(): void {
    if (this.useSqlite && this.sqliteDb) this.sqliteDb.close();
    if (this.jsonStore) this.jsonStore.flush();
  }

  private assertReady(): void {
    if (!this.isReady()) throw new Error('Database not initialized');
  }

  // ── Key/value settings ──────────────────────────────────────

  getSetting(key: string): string | null {
    if (!this.isReady()) return null;
    if (this.useSqlite) {
      const row = this.sqliteDb.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return row ? row.value : null;
    }
    const row = this.jsonStore!.table('settings').find((r: any) => r.key === key);
    return row ? row.value : null;
  }

  setSetting(key: string, value: string): void {
    if (!this.isReady()) return;
    if (this.useSqlite) {
      this.sqliteDb.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).run(key, value);
      return;
    }
    const t = this.jsonStore!.table('settings');
    const rec = { key, value, updated_at: new Date().toISOString() };
    const idx = t.findIndex((r: any) => r.key === key);
    if (idx >= 0) t[idx] = rec; else t.push(rec);
    this.jsonStore!.save();
  }

  deleteSetting(key: string): void {
    if (!this.isReady()) return;
    if (this.useSqlite) {
      this.sqliteDb.prepare('DELETE FROM settings WHERE key = ?').run(key);
      return;
    }
    const t = this.jsonStore!.table('settings');
    const idx = t.findIndex((r: any) => r.key === key);
    if (idx >= 0) { t.splice(idx, 1); this.jsonStore!.save(); }
  }

  getAllSettings(): Array<{ key: string; value: string }> {
    if (!this.isReady()) return [];
    if (this.useSqlite) return this.sqliteDb.prepare('SELECT key, value FROM settings').all();
    return this.jsonStore!.table('settings').map((r: any) => ({ key: r.key, value: r.value }));
  }

  // ── Run lock (lease) ────────────────────────────────────────
  // SQLite: atomic across processes (Hostinger may run >1 worker).
  // JSON: in-process only (the JSON store itself is single-process).

  tryAcquireLock(name: string, owner: string, ttlMs: number): boolean {
    const now = Date.now();
    const expires = now + ttlMs;
    if (this.useSqlite) {
      const key = `lock:${name}`;
      const value = `${expires}|${owner}`;
      const info = this.sqliteDb.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
         WHERE CAST(substr(settings.value, 1, instr(settings.value, '|') - 1) AS INTEGER) < ?`
      ).run(key, value, now);
      return info.changes === 1;
    }
    const cur = this.memLocks.get(name);
    if (cur && cur.expires >= now) return false;
    this.memLocks.set(name, { owner, expires });
    return true;
  }

  releaseLock(name: string, owner: string): void {
    if (this.useSqlite) {
      try {
        this.sqliteDb.prepare(`DELETE FROM settings WHERE key = ? AND value LIKE ?`)
          .run(`lock:${name}`, `%|${owner}`);
      } catch { /* expires on its own */ }
      return;
    }
    const cur = this.memLocks.get(name);
    if (cur && cur.owner === owner) this.memLocks.delete(name);
  }

  // ── System logs ─────────────────────────────────────────────

  addLog(level: string, category: string, message: string, meta?: object): void {
    if (!this.isReady()) return;
    const metadata = meta ? JSON.stringify(meta) : null;
    if (this.useSqlite) {
      this.sqliteDb.prepare(
        'INSERT INTO system_logs (level, category, message, metadata) VALUES (?, ?, ?, ?)'
      ).run(level, category, message, metadata);
      return;
    }
    const t = this.jsonStore!.table('system_logs');
    t.push({ id: this.jsonStore!.nextId('system_logs'), level, category, message, metadata, created_at: new Date().toISOString() });
    if (t.length > 500) t.splice(0, t.length - 500);
    this.jsonStore!.save();
  }

  // ── Projects: monitoring-critical operations ───────────────

  projectExists(projectId: string): boolean {
    this.assertReady();
    if (this.useSqlite) {
      return !!this.sqliteDb.prepare('SELECT 1 FROM projects WHERE project_id = ?').get(projectId);
    }
    return this.jsonStore!.table('projects').some((r: any) => r.project_id === projectId);
  }

  /** Returns true if inserted, false if the project already existed. */
  insertProject(p: NewProjectRow): boolean {
    this.assertReady();
    if (this.useSqlite) {
      const info = this.sqliteDb.prepare(
        `INSERT OR IGNORE INTO projects
          (project_id, title, url, budget, description, skills, classification, reason,
           matched_keywords, posted_at, notify_status, notify_attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
      ).run(
        p.project_id, p.title, p.url, p.budget, p.description, p.skills, p.classification,
        p.reason, p.matched_keywords, p.posted_at, p.notify_status
      );
      return info.changes === 1;
    }
    const t = this.jsonStore!.table('projects');
    if (t.some((r: any) => r.project_id === p.project_id)) return false;
    t.push({
      id: this.jsonStore!.nextId('projects'),
      ...p,
      notify_attempts: 0,
      last_notify_error: null,
      created_at: new Date().toISOString(),
      sent_at: null,
    });
    this.jsonStore!.save();
    return true;
  }

  /** Record the outcome of a Telegram delivery attempt. */
  recordNotifyResult(projectId: string, ok: boolean, error?: string): void {
    this.assertReady();
    const err = ok ? null : (error || 'unknown error').slice(0, 500);
    if (this.useSqlite) {
      if (ok) {
        this.sqliteDb.prepare(
          `UPDATE projects SET notify_status = 'sent', sent_at = datetime('now'),
             notify_attempts = COALESCE(notify_attempts, 0) + 1, last_notify_error = NULL
           WHERE project_id = ?`
        ).run(projectId);
      } else {
        this.sqliteDb.prepare(
          `UPDATE projects SET notify_status = 'failed',
             notify_attempts = COALESCE(notify_attempts, 0) + 1, last_notify_error = ?
           WHERE project_id = ?`
        ).run(err, projectId);
      }
      this.sqliteDb.prepare(
        `INSERT INTO notifications (project_id, telegram_status, error_message) VALUES (?, ?, ?)`
      ).run(projectId, ok ? 'sent' : 'failed', err);
      return;
    }
    const row = this.jsonStore!.table('projects').find((r: any) => r.project_id === projectId);
    if (row) {
      row.notify_attempts = (row.notify_attempts || 0) + 1;
      if (ok) { row.notify_status = 'sent'; row.sent_at = new Date().toISOString(); row.last_notify_error = null; }
      else { row.notify_status = 'failed'; row.last_notify_error = err; }
    }
    const n = this.jsonStore!.table('notifications');
    n.push({ id: this.jsonStore!.nextId('notifications'), project_id: projectId, telegram_status: ok ? 'sent' : 'failed', error_message: err, sent_at: new Date().toISOString() });
    if (n.length > 2000) n.splice(0, n.length - 2000);
    this.jsonStore!.save();
  }

  /** Matched projects whose notification is pending/failed and still worth retrying. */
  getRetryableProjects(sinceIso: string, maxAttempts: number, limit = 20): RetryableProject[] {
    this.assertReady();
    if (this.useSqlite) {
      // created_at is SQLite UTC 'YYYY-MM-DD HH:MM:SS'; compare in the same format
      const since = sinceIso.replace('T', ' ').replace(/\.\d+Z$|Z$/, '');
      return this.sqliteDb.prepare(
        `SELECT project_id, title, url, budget, description, skills, matched_keywords,
                posted_at, COALESCE(notify_attempts, 0) AS notify_attempts, created_at
         FROM projects
         WHERE classification = 'matched'
           AND notify_status IN ('pending', 'failed')
           AND COALESCE(notify_attempts, 0) < ?
           AND created_at >= ?
         ORDER BY created_at ASC
         LIMIT ?`
      ).all(maxAttempts, since, limit);
    }
    const since = new Date(sinceIso).getTime();
    return this.jsonStore!.table('projects')
      .filter((r: any) =>
        r.classification === 'matched' &&
        (r.notify_status === 'pending' || r.notify_status === 'failed') &&
        (r.notify_attempts || 0) < maxAttempts &&
        new Date(r.created_at).getTime() >= since)
      .sort((a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      .slice(0, limit)
      .map((r: any) => ({ ...r, notify_attempts: r.notify_attempts || 0 }));
  }

  /** Mark a queued notification as permanently skipped (e.g. gave up). */
  markNotifySkipped(projectId: string, reason: string): void {
    this.assertReady();
    if (this.useSqlite) {
      this.sqliteDb.prepare(
        `UPDATE projects SET notify_status = 'skipped', last_notify_error = ? WHERE project_id = ?`
      ).run(reason.slice(0, 500), projectId);
      return;
    }
    const row = this.jsonStore!.table('projects').find((r: any) => r.project_id === projectId);
    if (row) { row.notify_status = 'skipped'; row.last_notify_error = reason.slice(0, 500); this.jsonStore!.save(); }
  }

  updateProjectClassification(projectId: string, classification: string, reason: string, matchedKeywords: string, notifyStatus: NotifyStatus | null): void {
    this.assertReady();
    if (this.useSqlite) {
      this.sqliteDb.prepare(
        `UPDATE projects SET classification = ?, reason = ?, matched_keywords = ?, notify_status = ? WHERE project_id = ?`
      ).run(classification, reason, matchedKeywords, notifyStatus, projectId);
      return;
    }
    const row = this.jsonStore!.table('projects').find((r: any) => r.project_id === projectId);
    if (row) {
      row.classification = classification; row.reason = reason;
      row.matched_keywords = matchedKeywords; row.notify_status = notifyStatus;
      this.jsonStore!.save();
    }
  }

  notificationCounts(): { pending: number; failed: number; sent: number } {
    if (!this.isReady()) return { pending: 0, failed: 0, sent: 0 };
    if (this.useSqlite) {
      const rows = this.sqliteDb.prepare(
        `SELECT notify_status AS s, COUNT(*) AS c FROM projects WHERE notify_status IS NOT NULL GROUP BY notify_status`
      ).all() as Array<{ s: string; c: number }>;
      const m: Record<string, number> = {};
      for (const r of rows) m[r.s] = Number(r.c);
      return { pending: m.pending || 0, failed: m.failed || 0, sent: m.sent || 0 };
    }
    const out = { pending: 0, failed: 0, sent: 0 };
    for (const r of this.jsonStore!.table('projects')) {
      if (r.notify_status === 'pending') out.pending++;
      else if (r.notify_status === 'failed') out.failed++;
      else if (r.notify_status === 'sent') out.sent++;
    }
    return out;
  }

  // ── Schema & migrations ─────────────────────────────────────

  private createSqliteTables(): void {
    this.sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        budget TEXT,
        description TEXT,
        skills TEXT,
        classification TEXT DEFAULT 'matched',
        reason TEXT,
        matched_keywords TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        sent_at DATETIME
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        telegram_status TEXT DEFAULT 'pending',
        error_message TEXT,
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS system_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        category TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_projects_created ON projects(created_at);
      CREATE INDEX IF NOT EXISTS idx_projects_class ON projects(classification);
      CREATE INDEX IF NOT EXISTS idx_logs_created ON system_logs(created_at);
    `);
  }

  /** Additive, idempotent migration of databases created by v3.1.x. */
  private migrateSqlite(): void {
    const cols = new Set<string>(
      (this.sqliteDb.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>).map(c => c.name)
    );
    const add = (name: string, ddl: string) => {
      if (!cols.has(name)) this.sqliteDb.exec(`ALTER TABLE projects ADD COLUMN ${ddl}`);
    };
    add('posted_at', 'posted_at TEXT');
    add('notify_status', 'notify_status TEXT');
    add('notify_attempts', 'notify_attempts INTEGER DEFAULT 0');
    add('last_notify_error', 'last_notify_error TEXT');
    this.sqliteDb.exec(`CREATE INDEX IF NOT EXISTS idx_projects_notify ON projects(notify_status)`);

    // Legacy rows: sent → 'sent'. Legacy matched-but-unsent rows are left
    // NULL on purpose: they are months old and must not be re-sent now.
    this.sqliteDb.exec(`UPDATE projects SET notify_status = 'sent' WHERE sent_at IS NOT NULL AND notify_status IS NULL`);

    // Keep only one default setting that the job reads
    this.sqliteDb.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('monitoring_active', 'true')`).run();
  }

  private migrateJson(): void {
    const store = this.jsonStore!;
    for (const r of store.table('projects')) {
      if (r.notify_status === undefined) r.notify_status = r.sent_at ? 'sent' : null;
      if (r.notify_attempts === undefined) r.notify_attempts = 0;
      if (r.last_notify_error === undefined) r.last_notify_error = null;
      if (r.posted_at === undefined) r.posted_at = null;
    }
    const settings = store.table('settings');
    if (!settings.find((r: any) => r.key === 'monitoring_active')) {
      settings.push({ key: 'monitoring_active', value: 'true', updated_at: new Date().toISOString() });
    }
  }

  /**
   * v3.1.x copied TELEGRAM_BOT_TOKEN / CHAT_ID into the settings table in
   * plain text. Remove those copies — credentials live only in env vars.
   * Also prune old rows so the store does not grow forever.
   */
  private cleanupSecretsAndOldRows(): void {
    try {
      for (const k of SECRET_SETTING_KEYS) this.deleteSetting(k);
      const cutoff = new Date(Date.now() - PROJECT_RETENTION_DAYS * 86400000);
      if (this.useSqlite) {
        const c = cutoff.toISOString().replace('T', ' ').slice(0, 19);
        this.sqliteDb.prepare(`DELETE FROM projects WHERE created_at < ?`).run(c);
        this.sqliteDb.prepare(`DELETE FROM notifications WHERE sent_at < ?`).run(c);
        this.sqliteDb.prepare(`DELETE FROM system_logs WHERE created_at < datetime('now', '-14 days')`).run();
      } else if (this.jsonStore) {
        const t = this.jsonStore.table('projects');
        const kept = t.filter((r: any) => !r.created_at || new Date(r.created_at) >= cutoff);
        if (kept.length !== t.length) { t.splice(0, t.length, ...kept); }
      }
    } catch (e: any) {
      logger.warn(`Startup cleanup failed: ${e.message}`);
    }
  }

  // ── JSON SQL emulator (dashboard endpoints only) ───────────

  private jsonRun(sql: string, params: any[]): void {
    const store = this.jsonStore!;
    const s = sql.trim().toUpperCase();

    if (s.includes('INTO SETTINGS')) {
      const key = params[0];
      const t = store.table('settings');
      const idx = t.findIndex((r: any) => r.key === key);
      const rec = { key, value: params[1], updated_at: new Date().toISOString() };
      if (idx >= 0) t[idx] = rec; else t.push(rec);
    } else if (s.startsWith('INSERT INTO SYSTEM_LOGS')) {
      this.addLog(params[0], params[1], params[2], params[3] ? safeParse(params[3]) : undefined);
      return;
    } else if (s.startsWith('DELETE FROM SYSTEM_LOGS')) {
      const cutoff = Date.now() - 7 * 86400000;
      const t = store.table('system_logs');
      const kept = t.filter((r: any) => new Date(r.created_at).getTime() >= cutoff);
      t.splice(0, t.length, ...kept);
    } else {
      logger.warn(`JSON store: unsupported write ignored: ${sql.trim().slice(0, 80)}`);
      return;
    }
    store.save();
  }

  private jsonQuery<T>(sql: string, params: any[]): T[] {
    const store = this.jsonStore!;
    const s = sql.trim().toUpperCase();

    if (s.includes('FROM SETTINGS')) {
      if (s.includes('WHERE KEY = ?')) return store.table('settings').filter((r: any) => r.key === params[0]) as T[];
      const lit = /WHERE\s+KEY\s*=\s*'([^']+)'/i.exec(sql);
      if (lit) return store.table('settings').filter((r: any) => r.key === lit[1]) as T[];
      return store.table('settings') as T[];
    }

    if (s.includes('FROM PROJECTS') && s.includes('COUNT(*)') && !s.includes('GROUP BY')) {
      return [{ cnt: store.table('projects').length }] as T[];
    }
    if (s.includes('FROM PROJECTS') && s.includes('GROUP BY CLASSIFICATION')) {
      const m: Record<string, number> = {};
      for (const r of store.table('projects')) m[r.classification] = (m[r.classification] || 0) + 1;
      return Object.entries(m).map(([classification, count]) => ({ classification, count })) as T[];
    }
    if (s.includes('FROM PROJECTS') && s.includes('WHERE PROJECT_ID')) {
      return store.table('projects').filter((r: any) => r.project_id === params[0]) as T[];
    }
    if (s.includes('FROM PROJECTS') && !s.includes('GROUP BY')) {
      const rows = [...store.table('projects')];
      rows.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      // LIMIT ? OFFSET ? are the last two params
      const lim = s.includes('LIMIT ?') ? Number(params[params.length - 2]) : undefined;
      const off = s.includes('OFFSET ?') ? Number(params[params.length - 1]) : 0;
      return rows.slice(off, lim !== undefined ? off + lim : undefined) as T[];
    }
    if (s.includes('FROM SYSTEM_LOGS') && s.includes('COUNT(*)')) {
      return [{ cnt: store.table('system_logs').length }] as T[];
    }
    if (s.includes('FROM SYSTEM_LOGS')) {
      const rows = [...store.table('system_logs')];
      rows.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      const lim = s.includes('LIMIT ?') ? Number(params[params.length - 2]) : undefined;
      const off = s.includes('OFFSET ?') ? Number(params[params.length - 1]) : 0;
      return rows.slice(off, lim !== undefined ? off + lim : undefined) as T[];
    }
    if (s.includes('FROM NOTIFICATIONS')) return store.table('notifications') as T[];
    return [];
  }
}

function safeParse(v: any): any {
  try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return { raw: String(v) }; }
}
````

### `src/repositories/ProjectRepository.ts`

````typescript
import { Database, NewProjectRow, RetryableProject } from '../database/Database';
import { ProjectRecord, ProjectFilter, PaginatedResult, NotifyStatus } from '../modules/types';

export class ProjectRepository {
  private get db() { return Database.getInstance(); }

  /** Throws if the database is unavailable — callers must NOT treat that as "new". */
  exists(projectId: string): boolean {
    return this.db.projectExists(projectId);
  }

  /** Returns true if the row was inserted, false if it already existed. */
  save(data: NewProjectRow): boolean {
    return this.db.insertProject(data);
  }

  recordNotifyResult(projectId: string, ok: boolean, error?: string): void {
    this.db.recordNotifyResult(projectId, ok, error);
  }

  markNotifySkipped(projectId: string, reason: string): void {
    this.db.markNotifySkipped(projectId, reason);
  }

  getRetryable(sinceIso: string, maxAttempts: number, limit = 20): RetryableProject[] {
    return this.db.getRetryableProjects(sinceIso, maxAttempts, limit);
  }

  updateClassification(projectId: string, classification: string, reason: string, matchedKeywords: string, notifyStatus: NotifyStatus | null): void {
    this.db.updateProjectClassification(projectId, classification, reason, matchedKeywords, notifyStatus);
  }

  findById(projectId: string): ProjectRecord | null {
    return this.db.queryOne<ProjectRecord>(
      'SELECT * FROM projects WHERE project_id = ?', [projectId]
    );
  }

  findAll(filter: ProjectFilter = {}): PaginatedResult<ProjectRecord> {
    const { search = '', classification, page = 1, limit = 20 } = filter;
    const conds: string[] = [];
    const params: any[] = [];

    if (search) { conds.push('(title LIKE ? OR description LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
    if (classification) { conds.push('classification = ?'); params.push(classification); }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const countRow = this.db.queryOne<any>(`SELECT COUNT(*) as cnt FROM projects ${where}`, params);
    const total = Number(countRow?.cnt ?? countRow?.['COUNT(*)'] ?? 0);
    const data = this.db.queryAll<ProjectRecord>(
      `SELECT * FROM projects ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  getStats() {
    const total = Number(this.db.queryOne<any>('SELECT COUNT(*) as cnt FROM projects')?.cnt ?? 0);
    const today = Number(this.db.queryOne<any>("SELECT COUNT(*) as cnt FROM projects WHERE date(created_at) = date('now')")?.cnt ?? 0);
    const sent = Number(this.db.queryOne<any>('SELECT COUNT(*) as cnt FROM projects WHERE sent_at IS NOT NULL')?.cnt ?? 0);
    const clsRows = this.db.queryAll<{ classification: string; count: number }>(
      'SELECT classification, COUNT(*) as count FROM projects GROUP BY classification'
    );
    const byClassification: Record<string, number> = {};
    for (const r of clsRows) byClassification[r.classification] = Number(r.count);
    return { total, today, sent, avgScore: 0, byClassification };
  }

  getDailyCount(days = 14): Array<{ date: string; count: number }> {
    return this.db.queryAll(
      `SELECT date(created_at) as date, COUNT(*) as count FROM projects WHERE created_at >= date('now', ?) GROUP BY date(created_at) ORDER BY date ASC`,
      [`-${days} days`]
    );
  }

  getScoreDistribution(): Array<{ range: string; count: number }> {
    const rows = this.db.queryAll<{ classification: string; count: number }>(
      'SELECT classification, COUNT(*) as count FROM projects GROUP BY classification'
    );
    const get = (c: string) => Number(rows.find(r => r.classification === c)?.count ?? 0);
    return [{ range: 'matched', count: get('matched') }, { range: 'no_match', count: get('no_match') }];
  }
}
````

### `src/services/MostaqlScraperService.ts`

````typescript
import fs from 'fs';
import * as cheerio from 'cheerio';
import axios, { AxiosRequestConfig } from 'axios';
import {
  ScrapedProject, ScrapeAttempt, ScrapeResult, ScrapeStatus, ScrapeTransport,
} from '../modules/types';
import { AppConfig } from '../config/AppConfig';
import { Database } from '../database/Database';
import { logger } from '../utils/logger';
import { errorMessage, redact } from '../utils/redact';
import { parseUtc } from '../utils/projectAge';

const BASE_URL = 'https://mostaql.com';

// ──────────────────────────────────────────────────────────────
// Mostaql listing markup (re-verified 2026-09-29 against the raw,
// non-JS server response — 25 rows, no browser needed):
//
//   <tr class="project-row">
//     <h2 class="mrg--bt-reset">
//       <a href="https://mostaql.com/project/1281481-slug">TITLE</a>
//     </h2>
//     <time datetime="2026-09-29 09:40:06">  ← UTC, no zone suffix
//     <p class="text-wrapper-div project__brief">
//       <a class="details-url" href="...">DESCRIPTION</a>
//     </p>
//   </tr>
//
// Transports, tried in order until one returns SUCCESS or EMPTY:
//   1. direct     — plain HTTPS from this server
//   2. relay      — SCRAPER_RELAY_URL (Cloudflare Worker / scraping API)
//   3. proxy      — SCRAPER_PROXY_URL (HTTP(S) proxy)
//   4. playwright — only if PLAYWRIGHT_FALLBACK=true (local machines)
//
// Every failure is classified — nothing is converted into [].
// ──────────────────────────────────────────────────────────────

const CHALLENGE_MARKERS = [
  'cf-chl', 'challenge-platform', 'just a moment', 'attention required',
  'access denied', 'request unsuccessful', '_incapsula_resource', 'ddos-guard',
  'please enable javascript and cookies', 'verify you are human', 'captcha',
];
const EMPTY_MARKERS = ['لا توجد مشاريع', 'لا يوجد مشاريع', 'لم يتم العثور على'];

const COOLDOWN_KEY = 'scraper_direct_blocked_until';

interface ParsedPage {
  projects: ScrapedProject[];
  rowsFound: number;
  pageTitle: string;
}

interface Classified {
  status: ScrapeStatus;
  projects: ScrapedProject[];
  rowsFound?: number;
  pageTitle?: string;
  error?: string;
}

export class MostaqlScraperService {

  async fetchLatestProjects(): Promise<ScrapeResult> {
    const cfg = AppConfig.scraper;
    const attempts: ScrapeAttempt[] = [];

    const transports: ScrapeTransport[] = [];
    const cooldownUntil = this.getDirectCooldown();
    const hasAlternative = !!(cfg.relayUrl || cfg.proxyUrl || cfg.playwrightEnabled);

    if (!cooldownUntil) transports.push('direct');
    if (cfg.relayUrl) transports.push('relay');
    if (cfg.proxyUrl) transports.push('proxy');
    if (cfg.playwrightEnabled) transports.push('playwright');

    if (transports.length === 0) {
      // Only direct is configured and it is cooling down after a block.
      logger.warn(`⏸  Direct scraping paused until ${cooldownUntil} (Mostaql blocked this server). Configure SCRAPER_RELAY_URL or SCRAPER_PROXY_URL.`);
      return {
        status: 'SCRAPE_BLOCKED',
        projects: [],
        attempts,
        cooldown_until: cooldownUntil!,
        error: `Direct access blocked by Mostaql; paused until ${cooldownUntil}`,
      };
    }
    if (cooldownUntil && hasAlternative) {
      logger.info(`↪  Skipping direct transport (blocked, cooling down until ${cooldownUntil})`);
    }

    logger.info(`📡 Fetching projects from Mostaql via [${transports.join(' → ')}]`);

    for (const t of transports) {
      const attempt = await this.runTransport(t);
      attempts.push(attempt.meta);

      if (t === 'direct') {
        if (attempt.meta.status === 'SCRAPE_BLOCKED') this.setDirectCooldown();
        else if (attempt.meta.status === 'SCRAPE_SUCCESS' || attempt.meta.status === 'SCRAPE_EMPTY') this.clearDirectCooldown();
      }

      if (attempt.meta.status === 'SCRAPE_SUCCESS' || attempt.meta.status === 'SCRAPE_EMPTY') {
        logger.info(`✅ ${t}: ${attempt.meta.status} — ${attempt.projects.length} projects (${attempt.meta.duration_ms}ms)`);
        return { status: attempt.meta.status, projects: attempt.projects, transport: t, attempts };
      }
      logger.warn(`❌ ${t}: ${attempt.meta.status}` +
        (attempt.meta.http_status ? ` HTTP ${attempt.meta.http_status}` : '') +
        (attempt.meta.error ? ` — ${attempt.meta.error}` : '') +
        ` (${attempt.meta.duration_ms}ms)`);
    }

    // All transports failed: report the most specific cause.
    const priority: ScrapeStatus[] = ['SCRAPE_PARSE_FAILED', 'SCRAPE_BLOCKED', 'SCRAPE_FAILED'];
    const status = priority.find(p => attempts.some(a => a.status === p)) || 'SCRAPE_FAILED';
    const summary = attempts
      .map(a => `${a.transport}: ${a.status}${a.http_status ? ` HTTP ${a.http_status}` : ''}${a.error ? ` (${a.error})` : ''}`)
      .join('; ');
    return { status, projects: [], attempts, error: summary };
  }

  // ── Transport dispatch ─────────────────────────────────────

  private async runTransport(t: ScrapeTransport): Promise<{ meta: ScrapeAttempt; projects: ScrapedProject[] }> {
    const started = Date.now();
    try {
      switch (t) {
        case 'direct': return await this.viaHttp('direct', AppConfig.scraper.targetUrl, {}, started, 2);
        case 'relay': return await this.viaHttp('relay', this.buildRelayUrl(), this.relayHeaders(), started, 1);
        case 'proxy': return await this.viaHttp('proxy', AppConfig.scraper.targetUrl, await this.proxyConfig(), started, 1);
        case 'playwright': return await this.viaPlaywright(started);
      }
    } catch (e: any) {
      return {
        meta: { transport: t, status: 'SCRAPE_FAILED', duration_ms: Date.now() - started, error: errorMessage(e) },
        projects: [],
      };
    }
  }

  // ── HTTP transports (direct / relay / proxy) ───────────────

  private async viaHttp(
    transport: ScrapeTransport,
    url: string,
    extra: AxiosRequestConfig,
    started: number,
    maxTries: number,
  ): Promise<{ meta: ScrapeAttempt; projects: ScrapedProject[] }> {
    let last: { meta: ScrapeAttempt; projects: ScrapedProject[] } | null = null;

    for (let attempt = 1; attempt <= maxTries; attempt++) {
      try {
        const resp = await axios.get<string>(url, {
          timeout: AppConfig.scraper.timeoutMs,
          responseType: 'text',
          maxRedirects: 5,
          maxContentLength: 10 * 1024 * 1024,
          proxy: false,           // never pick up HTTP(S)_PROXY env implicitly
          decompress: true,
          validateStatus: () => true,
          ...extra,
          headers: { ...this.browserHeaders(), ...(extra.headers as Record<string, string> || {}) },
        });

        const body = typeof resp.data === 'string' ? resp.data : String(resp.data ?? '');
        const ct = String(resp.headers['content-type'] || '');
        const c = this.classify(resp.status, ct, body);

        last = {
          meta: {
            transport, status: c.status, http_status: resp.status,
            duration_ms: Date.now() - started, bytes: body.length,
            rows_found: c.rowsFound, page_title: c.pageTitle, error: c.error,
          },
          projects: c.projects,
        };

        // Retry only transient server errors, never blocks or parse failures.
        const transient = c.status === 'SCRAPE_FAILED' && resp.status >= 500 && resp.status !== 503;
        if (!transient) return last;
      } catch (e: any) {
        const code = e?.code || '';
        const timedOut = code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /timeout/i.test(e?.message || '');
        last = {
          meta: {
            transport, status: 'SCRAPE_FAILED', duration_ms: Date.now() - started,
            error: timedOut ? `timeout after ${AppConfig.scraper.timeoutMs}ms` : errorMessage(e),
          },
          projects: [],
        };
      }
      if (attempt < maxTries) await sleep(2000);
    }
    return last!;
  }

  /** Decide what an HTTP response means. Pure function — unit-testable. */
  classify(httpStatus: number, contentType: string, body: string): Classified {
    const lower = body.slice(0, 20000).toLowerCase();
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
    const pageTitle = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim().slice(0, 120) : undefined;
    const hint = pageTitle
      ? ` "${pageTitle}"`
      : (() => { const t = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100); return t ? ` "${t}"` : ''; })();

    if (httpStatus === 401 || httpStatus === 403 || httpStatus === 429) {
      return { status: 'SCRAPE_BLOCKED', projects: [], pageTitle, error: `HTTP ${httpStatus}${hint}` };
    }
    if (httpStatus === 503 && CHALLENGE_MARKERS.some(m => lower.includes(m))) {
      return { status: 'SCRAPE_BLOCKED', projects: [], pageTitle, error: 'HTTP 503 bot challenge' };
    }
    if (httpStatus !== 200) {
      return { status: 'SCRAPE_FAILED', projects: [], pageTitle, error: `unexpected HTTP ${httpStatus}${hint}` };
    }
    if (!body.trim()) {
      return { status: 'SCRAPE_FAILED', projects: [], error: 'empty response body' };
    }
    const looksHtml = /html/i.test(contentType) || /<html|<!doctype html/i.test(body.slice(0, 2000));
    if (!looksHtml) {
      return { status: 'SCRAPE_FAILED', projects: [], error: `expected HTML, got "${contentType || 'unknown content-type'}"` };
    }

    const parsed = this.parseHTML(body);
    if (parsed.projects.length > 0) {
      if (parsed.rowsFound > parsed.projects.length) {
        logger.warn(`Parser: ${parsed.rowsFound} rows found, only ${parsed.projects.length} parsed`);
      }
      return { status: 'SCRAPE_SUCCESS', projects: parsed.projects, rowsFound: parsed.rowsFound, pageTitle: parsed.pageTitle };
    }
    if (parsed.rowsFound > 0) {
      return {
        status: 'SCRAPE_PARSE_FAILED', projects: [], rowsFound: parsed.rowsFound, pageTitle: parsed.pageTitle,
        error: `${parsed.rowsFound} tr.project-row found but no title/link could be extracted — Mostaql markup changed`,
      };
    }
    if (CHALLENGE_MARKERS.some(m => lower.includes(m))) {
      return { status: 'SCRAPE_BLOCKED', projects: [], rowsFound: 0, pageTitle: parsed.pageTitle, error: `bot challenge page${pageTitle ? ` "${pageTitle}"` : ''}` };
    }
    if (EMPTY_MARKERS.some(m => body.includes(m))) {
      return { status: 'SCRAPE_EMPTY', projects: [], rowsFound: 0, pageTitle: parsed.pageTitle };
    }
    return {
      status: 'SCRAPE_PARSE_FAILED', projects: [], rowsFound: 0, pageTitle: parsed.pageTitle,
      error: `no tr.project-row in ${body.length} bytes${pageTitle ? ` (title "${pageTitle}")` : ''}`,
    };
  }

  // ── HTML parser ────────────────────────────────────────────

  parseHTML(html: string): ParsedPage {
    const $ = cheerio.load(html);
    const projects: ScrapedProject[] = [];
    const seen = new Set<string>();
    const rows = $('tr.project-row');

    rows.each((_, el) => {
      const $row = $(el);

      const $link = $row.find('h2 a[href*="/project/"]').first().length
        ? $row.find('h2 a[href*="/project/"]').first()
        : $row.find('a[href*="/project/"]').not('[href*="/project/create"]').first();
      const title = $link.text().replace(/\s+/g, ' ').trim();
      if (!title || title.length < 3) return;

      const href = $link.attr('href') || '';
      const idMatch = href.match(/\/project\/(\d+)/);
      if (!idMatch) return; // no stable numeric ID → skip rather than invent one

      const url = href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;
      const projectId = idMatch[1];
      if (seen.has(projectId)) return;
      seen.add(projectId);

      const description = (
        $row.find('p.project__brief a.details-url').first().text() ||
        $row.find('.project__brief').first().text() ||
        $row.find('.text-wrapper-div a').first().text()
      ).replace(/\s+/g, ' ').trim().slice(0, 600);

      const rawTime = $row.find('time[datetime]').attr('datetime');
      const posted = parseUtc(rawTime);

      projects.push({
        project_id: projectId,
        title,
        url,
        budget: 'غير محدد',
        description,
        skills: [],
        posted_at: posted ? posted.toISOString() : undefined,
      });
    });

    return { projects, rowsFound: rows.length, pageTitle: $('title').first().text().replace(/\s+/g, ' ').trim().slice(0, 120) };
  }

  // ── Playwright (opt-in, local only) ────────────────────────

  private async viaPlaywright(started: number): Promise<{ meta: ScrapeAttempt; projects: ScrapedProject[] }> {
    const fail = (status: ScrapeStatus, error: string, http?: number) => ({
      meta: { transport: 'playwright' as const, status, http_status: http, duration_ms: Date.now() - started, error },
      projects: [] as ScrapedProject[],
    });

    let chromium: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      chromium = require('playwright').chromium;
    } catch {
      return fail('SCRAPE_FAILED', 'playwright package not installed');
    }

    let exe = '';
    try { exe = chromium.executablePath(); } catch { /* ignore */ }
    if (!exe || !fs.existsSync(exe)) {
      return fail('SCRAPE_FAILED', `Chromium not installed for this Playwright version (run "npx playwright install chromium" on a machine that supports it)`);
    }

    let browser: any = null;
    try {
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
      const context = await browser.newContext({ userAgent: AppConfig.scraper.userAgent, locale: 'ar-SA' });
      const page = await context.newPage();
      const resp = await page.goto(AppConfig.scraper.targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const status = resp?.status() ?? 0;
      await page.waitForSelector('tr.project-row', { timeout: 15000 }).catch(() => undefined);
      const html = await page.content();
      const c = this.classify(status, 'text/html', html);
      return {
        meta: {
          transport: 'playwright', status: c.status, http_status: status, duration_ms: Date.now() - started,
          bytes: html.length, rows_found: c.rowsFound, page_title: c.pageTitle, error: c.error,
        },
        projects: c.projects,
      };
    } catch (e: any) {
      return fail('SCRAPE_FAILED', errorMessage(e).split('\n')[0]);
    } finally {
      if (browser) await browser.close().catch(() => undefined);
    }
  }

  // ── Helpers ────────────────────────────────────────────────

  private browserHeaders(): Record<string, string> {
    return {
      'User-Agent': AppConfig.scraper.userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Upgrade-Insecure-Requests': '1',
      'Referer': `${BASE_URL}/projects`,
    };
  }

  private buildRelayUrl(): string {
    const tpl = AppConfig.scraper.relayUrl;
    const target = encodeURIComponent(AppConfig.scraper.targetUrl);
    if (tpl.includes('{url}')) return tpl.replace('{url}', target);
    return `${tpl}${tpl.includes('?') ? '&' : '?'}url=${target}`;
  }

  private relayHeaders(): AxiosRequestConfig {
    const secret = AppConfig.scraper.relaySecret;
    return secret ? { headers: { 'X-Relay-Secret': secret } } : {};
  }

  private async proxyConfig(): Promise<AxiosRequestConfig> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { HttpsProxyAgent } = require('https-proxy-agent');
    const agent = new HttpsProxyAgent(AppConfig.scraper.proxyUrl);
    return { httpsAgent: agent, httpAgent: agent };
  }

  private getDirectCooldown(): string | null {
    if (AppConfig.scraper.blockCooldownMinutes <= 0) return null;
    try {
      const v = Database.getInstance().getSetting(COOLDOWN_KEY);
      if (v && new Date(v).getTime() > Date.now()) return v;
    } catch { /* DB down → no cooldown */ }
    return null;
  }

  private setDirectCooldown(): void {
    const mins = AppConfig.scraper.blockCooldownMinutes;
    if (mins <= 0) return;
    try {
      Database.getInstance().setSetting(COOLDOWN_KEY, new Date(Date.now() + mins * 60000).toISOString());
    } catch { /* non-critical */ }
  }

  private clearDirectCooldown(): void {
    try { Database.getInstance().deleteSetting(COOLDOWN_KEY); } catch { /* non-critical */ }
  }

  /** Describe transports for /api/status (no secrets). */
  describeTransports(): Record<string, unknown> {
    const cfg = AppConfig.scraper;
    return {
      target_url: cfg.targetUrl,
      direct: true,
      relay_configured: !!cfg.relayUrl,
      relay_host: cfg.relayUrl ? safeHost(cfg.relayUrl) : null,
      proxy_configured: !!cfg.proxyUrl,
      playwright_enabled: cfg.playwrightEnabled,
      direct_cooldown_until: this.getDirectCooldown(),
      timeout_ms: cfg.timeoutMs,
    };
  }
}

function safeHost(u: string): string {
  try { return new URL(u.replace('{url}', '')).host; } catch { return redact(u).slice(0, 40); }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
````

### `src/services/TelegramService.ts`

````typescript
import axios from 'axios';
import { ScrapedProject } from '../modules/types';
import { logger } from '../utils/logger';
import { AppConfig } from '../config/AppConfig';
import { redact, errorMessage } from '../utils/redact';

// ──────────────────────────────────────────────────────────────
// TelegramService
//
// • Credentials come ONLY from env vars (TELEGRAM_BOT_TOKEN,
//   TELEGRAM_CHAT_ID). They are never logged, stored or returned.
// • Messages use parse_mode=HTML with every dynamic value escaped.
//   (v3.1 used legacy Markdown without escaping, so any title or
//   description containing _ * [ or ` was rejected with HTTP 400
//   "can't parse entities".)
// • This service does not touch the database; the caller records
//   delivery state so a failed send is never marked as sent.
// ──────────────────────────────────────────────────────────────

export interface SendResult {
  ok: boolean;
  error?: string;
  /** Telegram error_code or HTTP status when available */
  code?: number;
}

type InlineKeyboard = Array<Array<{ text: string; url: string }>>;

const API = 'https://api.telegram.org';
const MAX_LEN = 4000;

export class TelegramService {

  private get token(): string { return AppConfig.telegram.botToken; }
  private get chatId(): string { return AppConfig.telegram.chatId; }

  isConfigured(): { ok: boolean; error?: string } {
    if (!this.token || !/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(this.token)) {
      return { ok: false, error: 'TELEGRAM_BOT_TOKEN is missing or malformed (expected "<digits>:<secret>")' };
    }
    if (!this.chatId) return { ok: false, error: 'TELEGRAM_CHAT_ID is missing' };
    return { ok: true };
  }

  /**
   * Send a project notification. Returns ok=true only when Telegram
   * accepted the main message. The second "copy" message is best-effort
   * and never causes a retry (which would duplicate the main message).
   */
  async sendMatchNotification(project: ScrapedProject, keywords: string[]): Promise<SendResult> {
    const cfg = this.isConfigured();
    if (!cfg.ok) {
      logger.error(`❌ Telegram not configured: ${cfg.error}`);
      return { ok: false, error: cfg.error };
    }

    const main = await this.sendMessage(this.buildInfoMessage(project, keywords), [
      [{ text: '🔗 فتح المشروع', url: project.url }],
    ]);
    if (!main.ok) {
      logger.error(`❌ Telegram send failed for ${project.project_id}: ${main.error}`);
      return main;
    }

    const copy = await this.sendMessage(this.buildCopyMessage(project, keywords));
    if (!copy.ok) logger.warn(`Telegram copy-message failed for ${project.project_id} (main message was delivered): ${copy.error}`);

    logger.info(`✅ Telegram sent: "${project.title.slice(0, 80)}"`);
    return { ok: true };
  }

  /** Operational alert (scraper down / recovered). */
  async sendAlert(text: string): Promise<SendResult> {
    const cfg = this.isConfigured();
    if (!cfg.ok) return { ok: false, error: cfg.error };
    return this.sendMessage(text);
  }

  async testConnection(): Promise<{ success: boolean; status: string; info?: string; error?: string }> {
    const cfg = this.isConfigured();
    if (!cfg.ok) return { success: false, status: 'TELEGRAM_NOT_CONFIGURED', error: cfg.error };

    try {
      const r = await axios.get(`${API}/bot${this.token}/getMe`, { timeout: 8000, validateStatus: () => true });
      if (!r.data?.ok) {
        return { success: false, status: 'TELEGRAM_FAILED', error: this.describeApiError(r.status, r.data) };
      }
      const bot = r.data.result;
      const sent = await this.sendMessage('✅ <b>Mostaql Monitor</b> — Telegram connection test successful.');
      if (!sent.ok) {
        return { success: false, status: 'TELEGRAM_FAILED', error: `Bot @${bot.username} is valid, but sending to the chat failed: ${sent.error}` };
      }
      return { success: true, status: 'SUCCESS', info: `@${bot.username} — test message delivered` };
    } catch (e: any) {
      return { success: false, status: 'TELEGRAM_FAILED', error: errorMessage(e) };
    }
  }

  // ── Low-level send with one 429 retry ──────────────────────

  private async sendMessage(text: string, keyboard?: InlineKeyboard): Promise<SendResult> {
    const parts = text.length <= MAX_LEN ? [text] : this.splitText(text, MAX_LEN);

    for (let i = 0; i < parts.length; i++) {
      const body: Record<string, unknown> = {
        chat_id: this.chatId,
        text: parts[i],
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      };
      if (i === parts.length - 1 && keyboard) body.reply_markup = { inline_keyboard: keyboard };

      let res = await this.post(body);
      if (!res.ok && res.code === 429 && res.retryAfter && res.retryAfter <= 15) {
        await new Promise(r => setTimeout(r, res.retryAfter! * 1000));
        res = await this.post(body);
      }
      if (!res.ok) return { ok: false, error: res.error, code: res.code };
    }
    return { ok: true };
  }

  private async post(body: Record<string, unknown>): Promise<SendResult & { retryAfter?: number }> {
    try {
      const r = await axios.post(`${API}/bot${this.token}/sendMessage`, body, {
        timeout: AppConfig.telegram.timeoutMs,
        validateStatus: () => true,
      });
      if (r.data?.ok) return { ok: true };
      return {
        ok: false,
        code: r.data?.error_code ?? r.status,
        error: this.describeApiError(r.status, r.data),
        retryAfter: r.data?.parameters?.retry_after,
      };
    } catch (e: any) {
      const timedOut = e?.code === 'ECONNABORTED' || /timeout/i.test(e?.message || '');
      return { ok: false, error: timedOut ? `Telegram timeout after ${AppConfig.telegram.timeoutMs}ms` : errorMessage(e) };
    }
  }

  private describeApiError(status: number, data: any): string {
    const desc = redact(data?.description || `HTTP ${status}`);
    const code = data?.error_code ?? status;
    if (code === 401) return `401 Unauthorized — TELEGRAM_BOT_TOKEN is invalid or revoked (${desc})`;
    if (code === 403) return `403 Forbidden — bot was blocked or removed from the chat (${desc})`;
    if (code === 400 && /chat not found/i.test(desc)) return `400 chat not found — check TELEGRAM_CHAT_ID and that you pressed Start in the bot chat`;
    if (code === 429) return `429 Too Many Requests (${desc})`;
    return `${code} ${desc}`;
  }

  // ── Message builders (HTML, escaped) ───────────────────────

  private buildInfoMessage(project: ScrapedProject, keywords: string[]): string {
    const description = (project.description || '').trim().slice(0, 400);
    const kwLine = keywords.slice(0, 6).join(', ');
    let msg = `🚀 <b>مشروع Front-End جديد على مستقل</b>\n\n`;
    msg += `📌 <b>العنوان:</b>\n${esc(project.title)}\n\n`;
    msg += `💰 <b>الميزانية:</b> ${esc(project.budget || 'غير محدد')}\n\n`;
    if (description) msg += `📝 <b>الوصف:</b>\n${esc(description)}\n\n`;
    msg += `🎯 <b>الكلمات المطابقة:</b> ${esc(kwLine)}\n\n`;
    msg += `🔗 ${esc(project.url)}`;
    return msg;
  }

  private buildCopyMessage(project: ScrapedProject, keywords: string[]): string {
    const description = (project.description || '').trim().slice(0, 400);
    const kwLine = keywords.slice(0, 6).join(', ');
    let content = `🚀 مشروع Front-End جديد على مستقل\n`;
    content += `📌 العنوان:\n${project.title}\n`;
    content += `💰 الميزانية: ${project.budget || 'غير محدد'}\n`;
    if (description) content += `📝 الوصف:\n${description}\n`;
    content += `🎯 الكلمات المطابقة: ${kwLine}\n`;
    content += `🔗 ${project.url}`;
    return `📋 اضغط على النص أدناه لنسخه:\n<pre>${esc(content)}</pre>`;
  }

  private splitText(text: string, max: number): string[] {
    const parts: string[] = [];
    let rem = text;
    while (rem.length > max) {
      const cut = rem.lastIndexOf('\n', max);
      const at = cut > max / 2 ? cut : max;
      parts.push(rem.slice(0, at));
      rem = rem.slice(at).trimStart();
    }
    if (rem) parts.push(rem);
    return parts;
  }
}

/** Escape for Telegram parse_mode=HTML. */
export function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
````

### `src/services/KeywordMatcherService.ts`

````typescript
import { ScrapedProject } from '../modules/types';
import { logger } from '../utils/logger';

const KEYWORDS_EN = [
  'html', 'css', 'javascript', 'typescript',
  'react', 'reactjs', 'react.js',
  'next.js', 'nextjs', 'next js',
  'vue', 'vuejs', 'nuxt', 'angular', 'svelte',
  'tailwind', 'tailwindcss', 'bootstrap', 'sass', 'scss',
  'material ui', 'shadcn', 'chakra',
  'figma', 'figma to html', 'figma to react',
  'psd to html', 'xd to html', 'adobe xd',
  'landing page', 'landing-page',
  'portfolio', 'portfolio website',
  'responsive', 'responsive design',
  'pixel perfect', 'ui developer', 'ux developer', 'ui/ux',
  'web design', 'web designer',
  'web developer', 'web development',
  'website design', 'website redesign', 'website',
  'static site', 'static website',
  'frontend', 'front-end', 'front end',
  'single page application',
  'shopify', 'wordpress theme', 'webflow', 'wix',
  'animation', 'gsap', 'framer motion',
  'vite', 'webpack',
  'prototype', 'mockup', 'wireframe',
  'mvp', 'interactive prototype',
];

const KEYWORDS_AR = [
  'صفحة هبوط', 'صفحة تعريفية', 'صفحة ويب', 'صفحة رئيسية', 'صفحة بسيطة', 'صفحة واحدة', 'صفحة شخصية',
  'موقع تعريفي', 'موقع شخصي', 'موقع إلكتروني', 'موقع الكتروني', 'موقع بسيط', 'موقع ويب',
  'موقع لشركة', 'موقع لمؤسسة', 'موقع شركة', 'موقع مؤسسة', 'موقع تفاعلي',
  'تصميم موقع', 'تطوير موقع', 'برمجة موقع', 'إنشاء موقع', 'انشاء موقع', 'صناعة موقع',
  'إضافة صفحات', 'تحسين موقع', 'إعادة تصميم', 'تصميم صفحة', 'تعديل موقع', 'نشر صفحة',
  'تحديث وتطوير', 'تصميم وتنفيذ', 'تصميم وتطوير',
  'فرونت اند', 'مصمم ويب', 'مطور واجهة', 'مطور ويب', 'مصمم مواقع',
  'واجهة مستخدم', 'واجهة أمامية', 'واجهة امامية', 'واجهات أمامية', 'واجهة', 'تصميم واجهة', 'تطوير واجهة',
  'تحويل تصميم', 'تنفيذ تصميم', 'تصميم ويب',
  'تحويل تصميم figma', 'تحويل تصميم xd', 'تحويل تصميم psd', 'تحويل ملف فيجما',
  'شوبيفاي', 'ووردبريس',
  'تصميم Landing Page', 'مطور Frontend', 'مصمم UI/UX',
  'متجاوبة', 'تكويد',
  'سلة', 'متجر سلة',
  'استضافة', 'هوستنجر',
  'موقع إلكتروني لشركة', 'موقع إلكتروني لمؤسسة',
  'موقع متعدد اللغات', 'موقع ثنائي اللغة', 'موقع عربي وإنجليزي',
];

export class KeywordMatcherService {

  matchProject(project: ScrapedProject): { matched: boolean; keywords: string[] } {
    // Match ONLY against the project TITLE
    const searchText = normalizeArabic(project.title || '');

    const matched: string[] = [];

    for (const kw of KEYWORDS_EN) {
      if (this.matchKeyword(searchText, kw.toLowerCase())) matched.push(kw);
    }
    for (const kw of KEYWORDS_AR) {
      if (searchText.includes(normalizeArabic(kw))) matched.push(kw);
    }

    const unique = [...new Set(matched)];
    if (unique.length > 0) {
      logger.info(`🎯 MATCH: "${project.title.slice(0, 60)}" → [${unique.join(', ')}]`);
    }

    return { matched: unique.length > 0, keywords: unique };
  }

  private matchKeyword(text: string, keyword: string): boolean {
    if (text.includes(keyword)) return true;
    const textNorm = text.replace(/[-\s.]/g, '');
    const kwNorm = keyword.replace(/[-\s.]/g, '');
    if (kwNorm.length >= 3 && textNorm.includes(kwNorm)) return true;
    return false;
  }

  getKeywordStats(projects: Array<{ matched_keywords: string }>): Record<string, number> {
    const stats: Record<string, number> = {};
    for (const p of projects) {
      if (!p.matched_keywords) continue;
      try {
        const kws: string[] = JSON.parse(p.matched_keywords);
        for (const kw of kws) stats[kw] = (stats[kw] || 0) + 1;
      } catch { /* skip */ }
    }
    return stats;
  }
}

/**
 * Lower-case + unify common Arabic spelling variants so that e.g.
 * "منصة سله" matches "سلة" and "انشاء" matches "إنشاء".
 */
export function normalizeArabic(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, '') // diacritics
    .replace(/\u0640/g, '')                 // tatweel
    .replace(/[\u200b-\u200f]/g, '')        // zero-width / direction marks
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[،,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
````

### `src/jobs/MonitoringJob.ts`

````typescript
import crypto from 'crypto';
import { MostaqlScraperService } from '../services/MostaqlScraperService';
import { KeywordMatcherService } from '../services/KeywordMatcherService';
import { TelegramService } from '../services/TelegramService';
import { ProjectRepository } from '../repositories/ProjectRepository';
import { Database } from '../database/Database';
import { AppConfig } from '../config/AppConfig';
import { logger } from '../utils/logger';
import { checkProjectAge, parseUtc } from '../utils/projectAge';
import { errorMessage } from '../utils/redact';
import { RunResult, RunStatus, ScrapedProject } from '../modules/types';

// ──────────────────────────────────────────────────────────────
// Persistent scheduler/health state (settings table, survives restarts)
// ──────────────────────────────────────────────────────────────
export const SchedulerState = {
  processStartTime: new Date().toISOString(),

  set(key: string, value: string): void {
    try { Database.getInstance().setSetting(key, value); } catch { /* non-critical */ }
  },

  get(key: string): string | null {
    try { return Database.getInstance().getSetting(key); } catch { return null; }
  },

  del(key: string): void {
    try { Database.getInstance().deleteSetting(key); } catch { /* non-critical */ }
  },
};

const LOCK_NAME = 'monitoring_run';
const FAILING_STATUSES: RunStatus[] = ['SCRAPE_FAILED', 'SCRAPE_BLOCKED', 'SCRAPE_PARSE_FAILED', 'SKIPPED_COOLDOWN'];

type Trigger = 'scheduler' | 'manual' | 'startup' | 'cron' | 're-evaluate';

export class MonitoringJob {
  private scraper = new MostaqlScraperService();
  private matcher = new KeywordMatcherService();
  private telegram = new TelegramService();
  private repo = new ProjectRepository();
  private timer: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  /** One in-flight run per process, shared by every caller. */
  private static inFlight: Promise<RunResult> | null = null;

  get mode(): 'internal' | 'external' { return AppConfig.monitoring.schedulerMode; }

  getScraper(): MostaqlScraperService { return this.scraper; }

  async start(): Promise<void> {
    SchedulerState.set('process_start_time', SchedulerState.processStartTime);
    SchedulerState.set('scheduler_mode', this.mode);
    logger.info(`⚙️  Scheduler mode: ${this.mode.toUpperCase()}`);

    if (AppConfig.monitoring.runOnStartup) {
      logger.info('▶️  Running startup check...');
      const r = await this.runCheck('startup');
      logger.info(`Startup check → ${r.status}`);
    }

    if (this.mode === 'external') {
      logger.info('⏸  Internal scheduler DISABLED — cron-job.org must POST /api/settings/run-check');
      return;
    }

    const interval = this.getInterval();
    this.timer = setInterval(() => { void this.runCheck('scheduler'); }, interval * 1000);
    logger.info(`✅ Internal scheduler started (every ${interval}s)`);

    this.watchdog = setInterval(() => {
      const last = SchedulerState.get('last_scheduler_run');
      if (!last) return;
      const diffMs = Date.now() - new Date(last).getTime();
      if (diffMs > interval * 3 * 1000) {
        const mins = Math.round(diffMs / 60000);
        logger.error(`🚨 SCHEDULER STALLED: no run in ${mins} minutes`);
        SchedulerState.set('scheduler_stalled', `true — last run ${mins}m ago`);
      } else {
        SchedulerState.set('scheduler_stalled', 'false');
      }
    }, 5 * 60 * 1000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    logger.info('🛑 Monitoring stopped');
  }

  isRunning(): boolean { return MonitoringJob.inFlight !== null; }

  // ── Main entry point ───────────────────────────────────────

  async runCheck(triggeredBy: Trigger = 'scheduler'): Promise<RunResult> {
    if (MonitoringJob.inFlight) {
      logger.info(`⏭  runCheck (${triggeredBy}) skipped — a run is already in progress in this process`);
      return this.result(triggeredBy, 'SKIPPED_ALREADY_RUNNING', Date.now(), {
        success: true, message: 'Another check is already running; this request did not start a second one.',
      });
    }
    const p = this.runExclusive(triggeredBy);
    MonitoringJob.inFlight = p;
    try { return await p; } finally { MonitoringJob.inFlight = null; }
  }

  private async runExclusive(triggeredBy: Trigger): Promise<RunResult> {
    const started = Date.now();
    const db = Database.getInstance();

    // Without a working store we cannot tell new projects from old ones,
    // so notifying would spam duplicates. Fail loudly instead.
    if (!db.isReady()) {
      const r = this.result(triggeredBy, 'ERROR', started, { error: 'Database is not initialized — refusing to run (duplicate-notification risk)' });
      logger.error(`❌ ${r.error}`);
      return r;
    }

    const owner = crypto.randomUUID();
    const ttl = AppConfig.monitoring.runLockTtlSeconds * 1000;
    let locked = false;
    try { locked = db.tryAcquireLock(LOCK_NAME, owner, ttl); } catch (e: any) {
      return this.result(triggeredBy, 'ERROR', started, { error: `Lock error: ${errorMessage(e)}` });
    }
    if (!locked) {
      logger.info(`⏭  runCheck (${triggeredBy}) skipped — another worker holds the run lock`);
      return this.result(triggeredBy, 'SKIPPED_ALREADY_RUNNING', started, {
        success: true, message: 'Another check is already running (another worker holds the lock).',
      });
    }

    SchedulerState.set('last_scheduler_run', new Date().toISOString());
    SchedulerState.set('scheduler_running', 'true');

    let result: RunResult;
    try {
      result = triggeredBy === 're-evaluate'
        ? await this.doReEvaluate(started)
        : await this.doRun(triggeredBy, started);
    } catch (e: any) {
      result = this.result(triggeredBy, 'ERROR', started, { error: errorMessage(e) });
      logger.error(`❌ runCheck internal error: ${result.error}`);
    } finally {
      SchedulerState.set('scheduler_running', 'false');
      db.releaseLock(LOCK_NAME, owner);
    }

    this.persistRunState(result);
    await this.handleHealthAlerts(result);
    db.flush();
    return result;
  }

  private async doRun(triggeredBy: Trigger, started: number): Promise<RunResult> {
    const db = Database.getInstance();

    if (db.getSetting('monitoring_active') === 'false') {
      logger.info('⏸  Monitoring paused (monitoring_active=false)');
      return this.result(triggeredBy, 'PAUSED', started, { success: true, message: 'Monitoring is paused (settings.monitoring_active=false).' });
    }

    logger.info(`🔍 [${triggeredBy.toUpperCase()}] Checking Mostaql...`);
    const scrape = await this.scraper.fetchLatestProjects();
    const scrapeInfo = { status: scrape.status, transport: scrape.transport, attempts: scrape.attempts };

    if (scrape.cooldown_until) {
      return this.result(triggeredBy, 'SKIPPED_COOLDOWN', started, {
        scrape: scrapeInfo, error: scrape.error,
        message: `Mostaql blocked direct requests from this server. Paused until ${scrape.cooldown_until}. Configure SCRAPER_RELAY_URL or SCRAPER_PROXY_URL.`,
      });
    }
    if (scrape.status !== 'SCRAPE_SUCCESS' && scrape.status !== 'SCRAPE_EMPTY') {
      logger.error(`❌ Scrape failed: ${scrape.status} — ${scrape.error}`);
      return this.result(triggeredBy, scrape.status, started, { scrape: scrapeInfo, error: scrape.error });
    }

    const counts = { scanned: scrape.projects.length, newCount: 0, matched: 0, notified: 0, notifyFailed: 0, retried: 0, skippedOld: 0 };
    const attemptedNow = new Set<string>();

    for (const project of scrape.projects) {
      // Throws if the DB is broken → whole run becomes ERROR (never "new")
      if (this.repo.exists(project.project_id)) continue;
      counts.newCount++;

      const { matched, keywords } = this.matcher.matchProject(project);
      const base = this.baseRow(project, keywords);

      if (!matched) {
        this.repo.save({ ...base, classification: 'no_match', reason: 'No keywords matched', notify_status: null });
        continue;
      }
      counts.matched++;

      const age = checkProjectAge(project.project_id, project.title, project.posted_at ?? null);
      if (!age.allowed) {
        counts.skippedOld++;
        this.repo.save({ ...base, classification: 'skipped_old', reason: age.reason, notify_status: 'skipped' });
        continue;
      }

      // Persist as PENDING first; only a confirmed Telegram delivery flips it to 'sent'.
      const inserted = this.repo.save({ ...base, classification: 'matched', reason: `Matched: ${keywords.join(', ')}`, notify_status: 'pending' });
      if (!inserted) continue; // another worker got it first

      attemptedNow.add(project.project_id);
      const sent = await this.telegram.sendMatchNotification(project, keywords);
      this.repo.recordNotifyResult(project.project_id, sent.ok, sent.error);
      if (sent.ok) counts.notified++; else counts.notifyFailed++;
      Database.getInstance().addLog(sent.ok ? 'info' : 'error', 'matching', `Matched: ${project.title}`, {
        project_id: project.project_id, keywords, sent: sent.ok, error: sent.error, triggeredBy, age_minutes: age.ageMinutes,
      });
    }

    // ── Retry notifications that failed on earlier runs ──────
    const retryResult = await this.retryPendingNotifications(attemptedNow);
    counts.retried = retryResult.attempted;
    counts.notified += retryResult.sent;
    counts.notifyFailed += retryResult.failed;

    const status: RunStatus = counts.notifyFailed > 0
      ? 'TELEGRAM_FAILED'
      : scrape.status === 'SCRAPE_EMPTY' ? 'SCRAPE_EMPTY' : 'SUCCESS';

    const r = this.result(triggeredBy, status, started, { ...counts, scrape: scrapeInfo });
    if (status === 'TELEGRAM_FAILED') r.error = 'One or more Telegram notifications failed; they will be retried on the next runs.';
    logger.info(
      `📊 [${triggeredBy.toUpperCase()}] ${status} in ${r.duration_ms}ms via ${scrape.transport} — ` +
      `scanned: ${r.scanned}, new: ${r.newCount}, matched: ${r.matched}, notified: ${r.notified}, ` +
      `failed: ${r.notifyFailed}, retried: ${r.retried}, skipped_old: ${r.skippedOld}`
    );
    return r;
  }

  private async retryPendingNotifications(exclude: Set<string>): Promise<{ attempted: number; sent: number; failed: number }> {
    const out = { attempted: 0, sent: 0, failed: 0 };
    const since = new Date(Date.now() - AppConfig.monitoring.notifyRetryWindowMinutes * 60000).toISOString();
    const rows = this.repo.getRetryable(since, AppConfig.monitoring.notifyMaxAttempts);

    for (const row of rows) {
      if (exclude.has(row.project_id)) continue;
      const keywords = safeJsonArray(row.matched_keywords);
      const project: ScrapedProject = {
        project_id: row.project_id, title: row.title, url: row.url, budget: row.budget,
        description: row.description, skills: safeJsonArray(row.skills), posted_at: row.posted_at ?? undefined,
      };
      out.attempted++;
      logger.info(`🔁 Retrying notification ${row.project_id} (attempt ${row.notify_attempts + 1}/${AppConfig.monitoring.notifyMaxAttempts})`);
      const sent = await this.telegram.sendMatchNotification(project, keywords);
      this.repo.recordNotifyResult(row.project_id, sent.ok, sent.error);
      if (sent.ok) out.sent++; else out.failed++;
      if (!sent.ok && row.notify_attempts + 1 >= AppConfig.monitoring.notifyMaxAttempts) {
        this.repo.markNotifySkipped(row.project_id, `Gave up after ${row.notify_attempts + 1} attempts: ${sent.error}`);
      }
    }
    return out;
  }

  // ── Manual re-evaluation of unsent no_match projects ───────

  async reEvaluateOldProjects(): Promise<RunResult> {
    return this.runCheck('re-evaluate');
  }

  private async doReEvaluate(started: number): Promise<RunResult> {
    logger.info('🔄 Re-evaluating unsent no_match projects...');
    const rows = Database.getInstance()
      .queryAll<any>(`SELECT * FROM projects WHERE classification = 'no_match' AND sent_at IS NULL`)
      .filter(r => r.classification === 'no_match' && !r.sent_at);

    let matched = 0, notified = 0, failed = 0, skippedOld = 0;
    for (const row of rows) {
      const project: ScrapedProject = {
        project_id: row.project_id, title: row.title, url: row.url, budget: row.budget,
        description: row.description, skills: safeJsonArray(row.skills),
        posted_at: row.posted_at || toIso(row.created_at),
      };
      const { matched: isMatch, keywords } = this.matcher.matchProject(project);
      if (!isMatch) continue;

      const age = checkProjectAge(project.project_id, project.title, project.posted_at ?? null);
      if (!age.allowed) {
        skippedOld++;
        this.repo.updateClassification(project.project_id, 'skipped_old', age.reason, JSON.stringify(keywords), 'skipped');
        continue;
      }
      matched++;
      this.repo.updateClassification(project.project_id, 'matched', `Re-matched: ${keywords.join(', ')}`, JSON.stringify(keywords), 'pending');
      const sent = await this.telegram.sendMatchNotification(project, keywords);
      this.repo.recordNotifyResult(project.project_id, sent.ok, sent.error);
      if (sent.ok) notified++; else failed++;
    }
    logger.info(`✅ Re-evaluation done — re-matched: ${matched}, notified: ${notified}, failed: ${failed}, skipped_old: ${skippedOld}`);
    return this.result('re-evaluate', failed > 0 ? 'TELEGRAM_FAILED' : 'SUCCESS', started, {
      scanned: rows.length, matched, notified, notifyFailed: failed, skippedOld,
    });
  }

  // ── State & alerts ─────────────────────────────────────────

  private persistRunState(r: RunResult): void {
    if (r.status === 'SKIPPED_ALREADY_RUNNING') return;
    const now = new Date().toISOString();
    SchedulerState.set('last_run_result', JSON.stringify(r));
    SchedulerState.set('last_scheduler_stats', JSON.stringify({
      status: r.status, scraped: r.scanned, matched: r.matched, notified: r.notified, at: now,
    }));

    const scrapeOk = r.scrape && (r.scrape.status === 'SCRAPE_SUCCESS' || r.scrape.status === 'SCRAPE_EMPTY');
    if (scrapeOk) {
      SchedulerState.set('last_successful_scrape', now);
      SchedulerState.set('last_successful_scrape_count', String(r.scanned));
    }
    if (r.notified > 0) SchedulerState.set('last_telegram_notification', now);

    if (r.status === 'SUCCESS' || r.status === 'SCRAPE_EMPTY' || r.status === 'PAUSED') {
      SchedulerState.set('last_error_cleared_at', now);
    } else if (r.error) {
      SchedulerState.set('last_scheduler_error', `${now}: [${r.status}] ${r.error}`);
    }
    if (r.status === 'TELEGRAM_FAILED') SchedulerState.set('last_telegram_error', `${now}: ${r.error}`);

    try {
      Database.getInstance().addLog(r.success ? 'info' : 'error', 'scheduler', `Check ${r.status} (${r.triggered_by})`, {
        scanned: r.scanned, newCount: r.newCount, matched: r.matched, notified: r.notified,
        notifyFailed: r.notifyFailed, retried: r.retried, skippedOld: r.skippedOld,
        duration_ms: r.duration_ms, transport: r.scrape?.transport, error: r.error,
      });
    } catch { /* non-critical */ }
  }

  /** Telegram alert when scraping has been failing for a while, and on recovery. */
  private async handleHealthAlerts(r: RunResult): Promise<void> {
    const afterMin = AppConfig.monitoring.alertAfterMinutes;
    if (afterMin <= 0 || r.status === 'SKIPPED_ALREADY_RUNNING' || r.status === 'PAUSED' || r.triggered_by === 're-evaluate') return;

    const now = Date.now();
    const failing = FAILING_STATUSES.includes(r.status);

    if (failing) {
      let since = SchedulerState.get('scrape_failing_since');
      if (!since) { since = new Date(now).toISOString(); SchedulerState.set('scrape_failing_since', since); }
      const failingMin = (now - new Date(since).getTime()) / 60000;
      const lastAlert = SchedulerState.get('health_alert_sent_at');
      const repeatDue = !lastAlert || now - new Date(lastAlert).getTime() > AppConfig.monitoring.alertRepeatHours * 3600000;
      if (failingMin >= afterMin && repeatDue) {
        const lastOk = SchedulerState.get('last_successful_scrape') || 'never';
        const text =
          `⚠️ <b>Mostaql Monitor: scraping is failing</b>\n\n` +
          `Status: <code>${r.status}</code>\n` +
          `Failing since: ${since}\n` +
          `Last successful scrape: ${lastOk}\n` +
          (r.error ? `Details: ${escapeHtml(r.error.slice(0, 600))}\n` : '') +
          (r.message ? `\n${escapeHtml(r.message)}` : '');
        const sent = await this.telegram.sendAlert(text);
        if (sent.ok) SchedulerState.set('health_alert_sent_at', new Date(now).toISOString());
        else logger.error(`Health alert could not be sent: ${sent.error}`);
      }
      return;
    }

    // Scrape worked this run → clear the incident, announce recovery if we alerted
    if (r.scrape && (r.scrape.status === 'SCRAPE_SUCCESS' || r.scrape.status === 'SCRAPE_EMPTY')) {
      const alerted = SchedulerState.get('health_alert_sent_at');
      const since = SchedulerState.get('scrape_failing_since');
      if (alerted) {
        await this.telegram.sendAlert(
          `✅ <b>Mostaql Monitor recovered</b>\nScraping works again via <code>${r.scrape.transport}</code> (${r.scanned} projects). Outage started ${since}.`
        );
      }
      SchedulerState.del('scrape_failing_since');
      SchedulerState.del('health_alert_sent_at');
    }
  }

  // ── Helpers ────────────────────────────────────────────────

  private baseRow(project: ScrapedProject, keywords: string[]) {
    return {
      project_id: project.project_id,
      title: project.title,
      url: project.url,
      budget: project.budget || 'غير محدد',
      description: project.description || '',
      skills: JSON.stringify(project.skills || []),
      matched_keywords: JSON.stringify(keywords),
      posted_at: project.posted_at ?? null,
    };
  }

  private result(triggeredBy: string, status: RunStatus, started: number, extra: Partial<RunResult> = {}): RunResult {
    const successStatuses: RunStatus[] = ['SUCCESS', 'SCRAPE_EMPTY', 'PAUSED', 'SKIPPED_ALREADY_RUNNING'];
    return {
      success: successStatuses.includes(status),
      status,
      triggered_by: triggeredBy,
      scanned: 0, newCount: 0, matched: 0, notified: 0, notifyFailed: 0, retried: 0, skippedOld: 0,
      duration_ms: Date.now() - started,
      ...extra,
    };
  }

  private getInterval(): number {
    let val = AppConfig.monitoring.checkIntervalSeconds;
    const fromDb = parseInt(SchedulerState.get('check_interval') || '', 10);
    if (Number.isFinite(fromDb) && fromDb >= 10) val = fromDb;
    return val;
  }
}

/** Process-wide singleton shared by index.ts and the HTTP controllers. */
export const monitoringJob = new MonitoringJob();

function safeJsonArray(v: any): string[] {
  try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; }
}

function toIso(v: string | null | undefined): string | undefined {
  const d = parseUtc(v);
  return d ? d.toISOString() : undefined;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
````

### `src/middleware/adminAuth.ts`

````typescript
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { AppConfig } from '../config/AppConfig';

// ──────────────────────────────────────────────────────────────
// Optional protection for state-changing endpoints.
//
// If ADMIN_TOKEN is empty the endpoints stay open (backwards
// compatible with the current cron-job.org setup). When it is set,
// callers must send ONE of:
//   Authorization: Bearer <ADMIN_TOKEN>
//   X-Admin-Token: <ADMIN_TOKEN>
//   ?token=<ADMIN_TOKEN>
// ──────────────────────────────────────────────────────────────
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const expected = AppConfig.adminToken;
  if (!expected) return next();

  const auth = String(req.headers.authorization || '');
  const supplied =
    (auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '') ||
    String(req.headers['x-admin-token'] || '') ||
    String((req.query as Record<string, unknown>).token || '');

  if (supplied && safeEqual(supplied, expected)) return next();
  res.status(401).json({ success: false, status: 'UNAUTHORIZED', error: 'Missing or invalid admin token' });
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
````

### `src/middleware/ErrorHandler.ts`

````typescript
import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { errorMessage } from '../utils/redact';

export function errorHandler(error: Error, req: Request, res: Response, _next: NextFunction): void {
  const msg = errorMessage(error);
  logger.error(`API error on ${req.method} ${req.path}: ${msg}`);
  res.status(500).json({ success: false, status: 'ERROR', error: 'Internal server error', message: msg });
}
````

### `src/controllers/SettingsController.ts`

````typescript
import { Router, Request, Response, NextFunction } from 'express';
import { Database } from '../database/Database';
import { TelegramService } from '../services/TelegramService';
import { monitoringJob } from '../jobs/MonitoringJob';
import { requireAdmin } from '../middleware/adminAuth';
import { RunResult } from '../modules/types';

export const settingsRouter = Router();
const telegram = new TelegramService();

// Settings that may be edited through the API. Credentials are env-only;
// internal state keys (locks, health, scheduler state) are read-only.
const EDITABLE_KEYS = new Set(['monitoring_active', 'check_interval']);
const HIDDEN_PREFIXES = ['lock:', 'telegram_'];

settingsRouter.get('/', (_req, res, next) => {
  try {
    const out: Record<string, string> = {};
    for (const r of Database.getInstance().getAllSettings()) {
      if (HIDDEN_PREFIXES.some(p => r.key.startsWith(p))) continue;
      out[r.key] = r.value;
    }
    res.json(out);
  } catch (e) { next(e); }
});

settingsRouter.put('/', requireAdmin, (req: Request, res: Response, next: NextFunction) => {
  try {
    const updates = (req.body || {}) as Record<string, unknown>;
    const applied: string[] = [];
    const rejected: string[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (!EDITABLE_KEYS.has(key)) { rejected.push(key); continue; }
      Database.getInstance().setSetting(key, String(value));
      applied.push(key);
    }
    res.json({ success: rejected.length === 0, applied, rejected });
  } catch (e) { next(e); }
});

settingsRouter.post('/test-telegram', requireAdmin, async (_req, res, next) => {
  try {
    const result = await telegram.testConnection();
    res.status(result.success ? 200 : 502).json(result);
  } catch (e) { next(e); }
});

settingsRouter.post('/toggle-monitoring', requireAdmin, (req, res, next) => {
  try {
    const { active } = (req.body || {}) as { active?: boolean };
    Database.getInstance().setSetting('monitoring_active', active ? 'true' : 'false');
    res.json({ success: true, monitoring_active: !!active });
  } catch (e) { next(e); }
});

// ── Run check — called by cron-job.org (external mode) or manually ──
//
// Always returns a JSON body with an explicit `status`:
//   SUCCESS | SCRAPE_EMPTY | SCRAPE_FAILED | SCRAPE_BLOCKED | SCRAPE_PARSE_FAILED
//   TELEGRAM_FAILED | SKIPPED_ALREADY_RUNNING | SKIPPED_COOLDOWN | PAUSED | ERROR
//
// HTTP status: 200 by default, even on failure, so cron-job.org does not
// auto-disable the job during a Mostaql outage (success:false + status tell
// you what happened, and a Telegram health alert is sent). Add ?strict=1 to
// get 502/503/500 on failure instead.
settingsRouter.post('/run-check', requireAdmin, async (req, res, next) => {
  try {
    const result = await monitoringJob.runCheck('cron');
    res.status(httpStatusFor(result, isStrict(req))).json(result);
  } catch (e) { next(e); }
});

// Manual re-evaluation — only unsent no_match projects; never resends sent ones
settingsRouter.post('/re-evaluate', requireAdmin, async (req, res, next) => {
  try {
    const result = await monitoringJob.reEvaluateOldProjects();
    res.status(httpStatusFor(result, isStrict(req))).json(result);
  } catch (e) { next(e); }
});

function isStrict(req: Request): boolean {
  const v = String((req.query as Record<string, unknown>).strict || '');
  return v === '1' || v === 'true';
}

function httpStatusFor(r: RunResult, strict: boolean): number {
  if (!strict || r.success) return 200;
  switch (r.status) {
    case 'SCRAPE_BLOCKED':
    case 'SKIPPED_COOLDOWN':
      return 503;
    case 'SCRAPE_FAILED':
    case 'SCRAPE_PARSE_FAILED':
    case 'TELEGRAM_FAILED':
      return 502;
    default:
      return 500;
  }
}
````

### `src/controllers/LogsController.ts`

````typescript
import { Router, Request, Response, NextFunction } from 'express';
import { Database } from '../database/Database';
import { requireAdmin } from '../middleware/adminAuth';

export const logsRouter = Router();

logsRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { category, level, page = '1', limit = '50' } = req.query as Record<string, string>;
    const conds: string[] = [];
    const params: any[] = [];
    if (category) { conds.push('category = ?'); params.push(category); }
    if (level) { conds.push('level = ?'); params.push(level); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const countRow = Database.getInstance().queryOne<any>(`SELECT COUNT(*) as cnt FROM system_logs ${where}`, params);
    const total = Number(countRow?.cnt ?? countRow?.['COUNT(*)'] ?? 0);
    const data = Database.getInstance().queryAll(
      `SELECT * FROM system_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );
    res.json({ data, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (e) { next(e); }
});

logsRouter.delete('/', requireAdmin, (_req, res, next) => {
  try {
    Database.getInstance().run(`DELETE FROM system_logs WHERE created_at < datetime('now', '-7 days')`);
    res.json({ success: true });
  } catch (e) { next(e); }
});
````

### `src/app.ts`

````typescript
import express, { Application } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { projectRouter } from './controllers/ProjectController';
import { settingsRouter } from './controllers/SettingsController';
import { logsRouter } from './controllers/LogsController';
import { statsRouter } from './controllers/StatsController';
import { errorHandler } from './middleware/ErrorHandler';
import { requestLogger } from './middleware/RequestLogger';
import { AppConfig } from './config/AppConfig';
import { Database } from './database/Database';
import { SchedulerState, monitoringJob } from './jobs/MonitoringJob';

export function createApp(): Application {
  const app = express();

  app.use(cors({ origin: '*' }));
  app.use(express.json());
  app.use(requestLogger);

  app.use('/api/projects', projectRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/logs', logsRouter);
  app.use('/api/stats', statsRouter);

  // ── Health check (liveness only) ──────────────────────────
  app.get('/health', (_, res) => {
    res.json({ status: 'ok', version: AppConfig.version, timestamp: new Date().toISOString(), uptime: process.uptime() });
  });

  // ── Full diagnostic status (no secrets) ───────────────────
  app.get('/api/status', (_, res) => {
    const db = Database.getInstance();
    const dbReady = (() => { try { return db.isReady(); } catch { return false; } })();
    const get = (k: string) => SchedulerState.get(k);
    const parse = (k: string) => { const v = get(k); try { return v ? JSON.parse(v) : null; } catch { return null; } };

    const lastRun = parse('last_run_result');
    const lastOk = get('last_successful_scrape');
    const minutesSinceScrape = lastOk ? Math.round((Date.now() - new Date(lastOk).getTime()) / 60000) : null;

    // Only show last_error if it happened after the last fully successful run
    const lastErr = get('last_scheduler_error');
    const clearedAt = get('last_error_cleared_at');
    const errAt = lastErr ? lastErr.slice(0, 24) : null;
    const errorIsCurrent = !!lastErr && (!clearedAt || (errAt !== null && errAt > clearedAt));

    const healthy = dbReady && !!lastRun && (lastRun.status === 'SUCCESS' || lastRun.status === 'SCRAPE_EMPTY');

    res.json({
      status: 'running',
      healthy,
      version: AppConfig.version,
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.round(process.uptime()),
      node_version: process.version,
      env: AppConfig.nodeEnv,
      port: AppConfig.port,

      database: {
        ready: dbReady,
        backend: db.backend(),
        init_error: db.initError || null,
        notifications: dbReady ? db.notificationCounts() : null,
      },
      database_ready: dbReady, // kept for backwards compatibility

      telegram: {
        token_set: !!AppConfig.telegram.botToken,
        chat_id_set: !!AppConfig.telegram.chatId,
        last_error: get('last_telegram_error') || null,
      },

      admin_token_required: !!AppConfig.adminToken,

      scraper: monitoringJob.getScraper().describeTransports(),

      scheduler: {
        mode: AppConfig.monitoring.schedulerMode,
        running: monitoringJob.isRunning() || get('scheduler_running') === 'true',
        stalled: get('scheduler_stalled') || 'false',
        check_interval_seconds: AppConfig.monitoring.checkIntervalSeconds,
        process_start_time: SchedulerState.processStartTime,
        last_scheduler_run: get('last_scheduler_run') || null,
        last_successful_scrape: lastOk || null,
        minutes_since_successful_scrape: minutesSinceScrape,
        last_telegram_notification: get('last_telegram_notification') || null,
        scrape_failing_since: get('scrape_failing_since') || null,
        last_run: lastRun,
        last_stats: parse('last_scheduler_stats'),
        last_error: lastErr || null,
        last_error_is_current: errorIsCurrent,
      },
    });
  });

  // ── Dashboard (if built) or minimal root page ─────────────
  // vite builds into dist/public; older layouts used ./public
  const candidates = [path.join(__dirname, 'public'), path.join(__dirname, '..', 'public')];
  const publicPath = candidates.find(p => fs.existsSync(path.join(p, 'index.html')));
  if (publicPath) {
    app.use(express.static(publicPath));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path === '/health') return next();
      res.sendFile(path.join(publicPath, 'index.html'));
    });
  } else {
    app.get('/', (_, res) => {
      res.send(`<html><body style="font-family:monospace;padding:20px">
        <h2>🚀 Mostaql Monitor v${AppConfig.version}</h2>
        <p>API running in <strong>${AppConfig.monitoring.schedulerMode}</strong> mode.</p>
        <ul>
          <li><a href="/health">GET /health</a></li>
          <li><a href="/api/status">GET /api/status</a></li>
          <li>POST /api/settings/test-telegram</li>
          <li>POST /api/settings/run-check</li>
        </ul>
      </body></html>`);
    });
  }

  app.use(errorHandler);
  return app;
}
````

### `src/index.ts`

````typescript
import 'dotenv/config';
import { createApp } from './app';
import { Database } from './database/Database';
import { logger } from './utils/logger';
import { monitoringJob } from './jobs/MonitoringJob';
import { AppConfig } from './config/AppConfig';
import { errorMessage } from './utils/redact';

async function bootstrap() {
  logger.info('═══════════════════════════════════════');
  logger.info(`  🚀 Mostaql Monitor v${AppConfig.version} starting...`);
  logger.info('═══════════════════════════════════════');
  logger.info(`NODE_ENV: ${AppConfig.nodeEnv}`);
  logger.info(`PORT: ${AppConfig.port}`);
  logger.info(`DB_PATH: ${AppConfig.dbPath}`);
  logger.info(`SCHEDULER_MODE: ${AppConfig.monitoring.schedulerMode}`);
  logger.info(`TELEGRAM_BOT_TOKEN: ${AppConfig.telegram.botToken ? 'set' : '❌ NOT SET'}`);
  logger.info(`TELEGRAM_CHAT_ID: ${AppConfig.telegram.chatId ? 'set' : '❌ NOT SET'}`);
  logger.info(`Scraper transports: direct${AppConfig.scraper.relayUrl ? ', relay' : ''}${AppConfig.scraper.proxyUrl ? ', proxy' : ''}${AppConfig.scraper.playwrightEnabled ? ', playwright' : ''}`);
  logger.info(`ADMIN_TOKEN: ${AppConfig.adminToken ? 'set (mutating endpoints protected)' : 'not set (endpoints open)'}`);

  // 1. Database (non-fatal for the API, but runs refuse to notify without it)
  try {
    await Database.getInstance().initialize();
  } catch (e: any) {
    logger.error(`⚠️  Database init failed: ${errorMessage(e)} — API will start, monitoring runs will report ERROR`);
  }

  // 2. Express API
  const app = createApp();
  app.listen(AppConfig.port, () => {
    logger.info(`✅ API running on port ${AppConfig.port}`);
  });

  // 3. Monitoring (reEvaluateOldProjects is manual-only: POST /api/settings/re-evaluate)
  await monitoringJob.start();

  const shutdown = (sig: string) => {
    logger.info(`${sig} — shutting down`);
    monitoringJob.stop();
    try { Database.getInstance().close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (r) => logger.error('Unhandled rejection: ' + errorMessage(r)));
  process.on('uncaughtException', (e) => logger.error('Uncaught exception: ' + errorMessage(e)));
}

bootstrap().catch((e) => { console.error('Fatal:', errorMessage(e)); process.exit(1); });
````

### `relay/cloudflare-worker.js`

````javascript
/**
 * Mostaql relay — Cloudflare Worker (free plan is enough).
 *
 * Why: Mostaql refuses requests coming from some datacenter IPs (the
 * Hostinger server gets blocked). This Worker fetches the listing from
 * Cloudflare's network and returns the raw HTML plus the real upstream
 * HTTP status, so the monitor can still classify BLOCKED / FAILED.
 *
 * Deploy:
 *   1. dash.cloudflare.com → Workers & Pages → Create → "Hello World" Worker
 *   2. Replace the code with this file → Deploy
 *   3. Settings → Variables and Secrets → add Secret  RELAY_SECRET = <random string>
 *   4. On Hostinger set:
 *        SCRAPER_RELAY_URL=https://<worker-name>.<subdomain>.workers.dev/
 *        SCRAPER_RELAY_SECRET=<same random string>
 *
 * Quick check in a browser (temporarily without secret, or with curl):
 *   curl -H "X-Relay-Secret: <secret>" \
 *     "https://<worker>.workers.dev/?url=https%3A%2F%2Fmostaql.com%2Fprojects"
 *   → HTTP 200 and HTML containing  class="project-row"  means it works.
 *
 * Security: only https://mostaql.com URLs are relayed, and a shared secret
 * is required when RELAY_SECRET is configured.
 */

const ALLOWED_HOSTS = new Set(['mostaql.com', 'www.mostaql.com']);

export default {
  async fetch(request, env) {
    if (request.method !== 'GET') {
      return new Response('relay: method not allowed', { status: 405 });
    }

    if (env.RELAY_SECRET && request.headers.get('X-Relay-Secret') !== env.RELAY_SECRET) {
      return new Response('relay: unauthorized (bad or missing X-Relay-Secret)', { status: 401 });
    }

    const target = new URL(request.url).searchParams.get('url');
    let url;
    try { url = new URL(target || ''); } catch {
      return new Response('relay: missing or invalid ?url=', { status: 400 });
    }
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
      return new Response('relay: host not allowed', { status: 400 });
    }

    const upstream = await fetch(url.toString(), {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
      },
      cf: { cacheTtl: 0, cacheEverything: false },
    });

    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') || 'text/html; charset=UTF-8',
        'cache-control': 'no-store',
        'x-upstream-status': String(upstream.status),
      },
    });
  },
};
````

_`setup.bat` changes only its step-2 label ("optional – only used when PLAYWRIGHT_FALLBACK=true"). `package-lock.json` is regenerated and included in the zip._
