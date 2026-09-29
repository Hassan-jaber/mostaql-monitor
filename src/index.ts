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
