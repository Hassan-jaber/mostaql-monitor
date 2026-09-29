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
