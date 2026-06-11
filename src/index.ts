import 'dotenv/config';
import { createApp } from './app';
import { Database } from './database/Database';
import { logger } from './utils/logger';
import { MonitoringJob } from './jobs/MonitoringJob';
import { AppConfig } from './config/AppConfig';

async function bootstrap() {
  logger.info('═══════════════════════════════════════');
  logger.info('  🚀 Mostaql Monitor v3.1.2 starting...');
  logger.info('═══════════════════════════════════════');
  logger.info(`NODE_ENV: ${AppConfig.nodeEnv}`);
  logger.info(`PORT: ${AppConfig.port}`);
  logger.info(`DB_PATH: ${AppConfig.dbPath}`);
  logger.info(`SCHEDULER_MODE: ${process.env.SCHEDULER_MODE || 'internal'}`);
  logger.info(`TELEGRAM_BOT_TOKEN: ${AppConfig.telegram.botToken ? AppConfig.telegram.botToken.slice(0, 8) + '***' : '❌ NOT SET'}`);
  logger.info(`TELEGRAM_CHAT_ID: ${AppConfig.telegram.chatId || '❌ NOT SET'}`);

  // 1. Database (non-fatal)
  try {
    await Database.getInstance().initialize();
  } catch (e: any) {
    logger.error(`⚠️  Database init failed: ${e.message} — continuing`);
  }

  // 2. Express API
  const app = createApp();
  app.listen(AppConfig.port, () => {
    logger.info(`✅ API running on port ${AppConfig.port}`);
    logger.info(`   /health`);
    logger.info(`   /api/status`);
    logger.info(`   POST /api/settings/test-telegram`);
    logger.info(`   POST /api/settings/run-check`);
  });

  // 3. Start monitoring
  // NOTE: reEvaluateOldProjects() is NOT called here.
  // It caused duplicate notifications on every restart.
  // Call it manually via a dedicated endpoint if needed.
  const job = new MonitoringJob();
  await job.start();

  const shutdown = (sig: string) => {
    logger.info(`${sig} — shutting down`);
    job.stop();
    try { Database.getInstance().close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (r) => logger.error('Unhandled: ' + r));
  process.on('uncaughtException', (e) => logger.error('Uncaught: ' + e.message));
}

bootstrap().catch((e) => { console.error('Fatal:', e); process.exit(1); });
