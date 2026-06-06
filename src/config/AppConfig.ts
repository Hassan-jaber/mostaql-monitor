import path from 'path';

// ──────────────────────────────────────────────────────────────
// AppConfig — single source of truth for all configuration.
//
// CRITICAL: Telegram credentials come from ENVIRONMENT VARIABLES.
// They are SEEDED into DB on startup for the settings API,
// but the monitoring job always reads from env vars directly
// so it works even if DB fails to initialize.
// ──────────────────────────────────────────────────────────────
export const AppConfig = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // Database — writable path required on Hostinger
  dbPath: process.env.DB_PATH || './data/mostaql.db',

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
  logDir: process.env.LOG_DIR || './logs',

  // ── Telegram — READ FROM ENV VARS DIRECTLY ─────────────────
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },

  // ── Monitoring ─────────────────────────────────────────────
  monitoring: {
    checkIntervalSeconds: parseInt(process.env.CHECK_INTERVAL_SECONDS || '60', 10),
  },

  paths: {
    data: path.resolve(process.cwd(), process.env.DATA_DIR || 'data'),
    logs: path.resolve(process.cwd(), process.env.LOG_DIR || 'logs'),
  },
} as const;
