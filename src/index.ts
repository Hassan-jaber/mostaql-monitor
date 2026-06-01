import 'dotenv/config';
import { createApp } from './app';
import { Database } from './database/Database';
import { logger } from './utils/logger';
import { MonitoringJob } from './jobs/MonitoringJob';
import { AppConfig } from './config/AppConfig';

async function bootstrap() {
  try {
    logger.info('═══════════════════════════════════════');
    logger.info('  🚀 Mostaql Monitor starting up...');
    logger.info('═══════════════════════════════════════');

    // 1. Database
    await Database.getInstance().initialize();

    // 2. Express API
    const app = createApp();
    app.listen(AppConfig.port, () => {
      logger.info(`✅ API running → http://localhost:${AppConfig.port}`);
      logger.info(`✅ Dashboard  → http://localhost:5173`);
    });

    // 3. Monitoring job
    const job = new MonitoringJob();

    // ── Re-evaluate old projects on startup ──────────────────
    // Projects saved by broken v2 code (as no_match) are re-checked.
    // This runs ONCE on startup, then normal monitoring continues.
    logger.info('🔄 Running one-time re-evaluation of old projects...');
    await job.reEvaluateOldProjects();

    // 4. Start continuous monitoring
    await job.start();

    // Graceful shutdown
    const shutdown = () => {
      logger.info('Shutting down...');
      job.stop();
      Database.getInstance().close();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    process.on('unhandledRejection', (r) => logger.error('Unhandled rejection: ' + r));
    process.on('uncaughtException', (e) => logger.error('Uncaught exception: ' + e.message));

  } catch (err: any) {
    console.error('Fatal startup error:', err);
    process.exit(1);
  }
}

bootstrap();
