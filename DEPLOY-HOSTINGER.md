# Mostaql Monitor v3.2 — Hostinger deployment, verification & rollback

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
# or, alternatively
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
