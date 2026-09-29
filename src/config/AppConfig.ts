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
