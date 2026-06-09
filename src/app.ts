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
import { SchedulerState } from './jobs/MonitoringJob';

export function createApp(): Application {
  const app = express();

  app.use(cors({ origin: '*' }));
  app.use(express.json());
  app.use(requestLogger);

  app.use('/api/projects', projectRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/logs', logsRouter);
  app.use('/api/stats', statsRouter);

  // ── Health check ──────────────────────────────────────────
  app.get('/health', (_, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() });
  });

  // ── Full diagnostic status ────────────────────────────────
  app.get('/api/status', (_, res) => {
    const dbReady = (() => { try { return Database.getInstance().isReady(); } catch { return false; } })();

    // Read all scheduler state from DB (survives restarts)
    const get = (k: string) => SchedulerState.get(k);

    res.json({
      status: 'running',
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.round(process.uptime()),
      node_version: process.version,
      env: AppConfig.nodeEnv,
      port: AppConfig.port,
      database_ready: dbReady,

      // Telegram config (no secrets exposed)
      telegram: {
        token_set: !!AppConfig.telegram.botToken,
        chat_id_set: !!AppConfig.telegram.chatId,
        token_preview: AppConfig.telegram.botToken
          ? AppConfig.telegram.botToken.slice(0, 8) + '***'
          : 'NOT SET',
      },

      // Scheduler diagnostics
      scheduler: {
        mode: get('scheduler_mode') || process.env.SCHEDULER_MODE || 'internal',
        running: get('scheduler_running') === 'true',
        stalled: get('scheduler_stalled') || 'false',
        check_interval_seconds: AppConfig.monitoring.checkIntervalSeconds,

        // These persist in DB across process restarts
        process_start_time: get('process_start_time') || SchedulerState.processStartTime,
        last_scheduler_run: get('last_scheduler_run') || null,
        last_successful_scrape: get('last_successful_scrape') || null,
        last_telegram_notification: get('last_telegram_notification') || null,
        last_stats: (() => {
          const s = get('last_scheduler_stats');
          try { return s ? JSON.parse(s) : null; } catch { return null; }
        })(),
        last_error: get('last_scheduler_error') || null,
      },
    });
  });

  // ── Root page ─────────────────────────────────────────────
  const publicPath = path.join(__dirname, '..', 'public');
  if (fs.existsSync(publicPath)) {
    app.use(express.static(publicPath));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path === '/health') return next();
      res.sendFile(path.join(publicPath, 'index.html'));
    });
  } else {
    app.get('/', (_, res) => {
      res.send(`<html><body style="font-family:monospace;padding:20px">
        <h2>🚀 Mostaql Monitor v3.1</h2>
        <p>API running in <strong>${process.env.SCHEDULER_MODE || 'internal'}</strong> mode.</p>
        <ul>
          <li><a href="/health">GET /health</a></li>
          <li><a href="/api/status">GET /api/status</a></li>
          <li>POST /api/settings/test-telegram</li>
          <li>POST /api/settings/run-check</li>
        </ul>
        ${process.env.SCHEDULER_MODE === 'external' ? `
        <p>⏰ <strong>External cron mode:</strong> Trigger checks by POSTing to
        <code>/api/settings/run-check</code> every 60s from cron-job.org.</p>` : ''}
      </body></html>`);
    });
  }

  app.use(errorHandler);
  return app;
}
