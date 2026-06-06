import 'dotenv/config';
import { createApp } from './app';
import { Database } from './database/Database';
import { logger } from './utils/logger';
import { MonitoringJob } from './jobs/MonitoringJob';
import { AppConfig } from './config/AppConfig';

async function bootstrap() {
  logger.info('═══════════════════════════════════════');
  logger.info('  🚀 Mostaql Monitor v3.0 starting...');
  logger.info('═══════════════════════════════════════');
  logger.info(`NODE_ENV: ${AppConfig.nodeEnv}`);
  logger.info(`PORT: ${AppConfig.port}`);
  logger.info(`DB_PATH: ${AppConfig.dbPath}`);
  logger.info(`TELEGRAM_BOT_TOKEN: ${AppConfig.telegram.botToken ? AppConfig.telegram.botToken.slice(0, 8) + '***' : '❌ NOT SET'}`);
  logger.info(`TELEGRAM_CHAT_ID: ${AppConfig.telegram.chatId || '❌ NOT SET'}`);
  logger.info(`CHECK_INTERVAL_SECONDS: ${AppConfig.monitoring.checkIntervalSeconds}`);

  // 1. Database (non-fatal — app continues even if DB fails)
  try {
    await Database.getInstance().initialize();
  } catch (e: any) {
    logger.error(`⚠️  Database initialization failed: ${e.message}`);
    logger.warn('Continuing without database — notifications will still work via env vars');
  }

  // 2. Express API
  const app = createApp();
  app.listen(AppConfig.port, () => {
    logger.info(`✅ API server running on port ${AppConfig.port}`);
    logger.info(`   Health check: http://localhost:${AppConfig.port}/health`);
    logger.info(`   Settings API: http://localhost:${AppConfig.port}/api/settings`);
    logger.info(`   Test Telegram: http://localhost:${AppConfig.port}/api/settings/test-telegram (POST)`);
  });

  // 3. Re-evaluate old projects (one-time on startup)
  const job = new MonitoringJob();
  try {
    await job.reEvaluateOldProjects();
  } catch (e: any) {
    logger.warn(`reEvaluateOldProjects skipped: ${e.message}`);
  }

  // 4. Start monitoring loop
  await job.start();

  // 5. Graceful shutdown
  const shutdown = (signal: string) => {
    logger.info(`${signal} received — shutting down`);
    job.stop();
    try { Database.getInstance().close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection: ' + String(reason));
  });
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception: ' + err.message);
    // Don't exit — keep the process alive on Hostinger
  });
}

bootstrap().catch((err) => {
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});
