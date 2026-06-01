import path from 'path';

export const AppConfig = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  dbPath: process.env.DB_PATH || './data/mostaql.db',
  logLevel: process.env.LOG_LEVEL || 'info',
  logDir: process.env.LOG_DIR || './logs',

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },

  // AI config kept for env-compat but not used
  ai: {
    provider: 'none' as const,
    apiKey: '',
    model: '',
    openRouterApiKey: '',
    openRouterModel: '',
  },

  monitoring: {
    checkIntervalSeconds: parseInt(process.env.CHECK_INTERVAL_SECONDS || '60', 10),
    minScoreThreshold: 0,
  },

  paths: {
    config: path.resolve(process.cwd(), 'config'),
    data: path.resolve(process.cwd(), 'data'),
    logs: path.resolve(process.cwd(), 'logs'),
  },
} as const;
