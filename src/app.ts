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

export function createApp(): Application {
  const app = express();

  app.use(cors({ origin: '*' }));
  app.use(express.json());
  app.use(requestLogger);

  // ── API routes ────────────────────────────────────────────
  app.use('/api/projects', projectRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/logs', logsRouter);
  app.use('/api/stats', statsRouter);

  // ── Health check ──────────────────────────────────────────
  app.get('/health', (_, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() });
  });

  // ── Diagnostic endpoint — shows all config (safe to expose) ─
  app.get('/api/status', (_, res) => {
    const dbReady = (() => { try { return Database.getInstance().isReady(); } catch { return false; } })();
    res.json({
      status: 'running',
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.round(process.uptime()),
      node_version: process.version,
      env: AppConfig.nodeEnv,
      port: AppConfig.port,
      database_ready: dbReady,
      telegram: {
        token_set: !!AppConfig.telegram.botToken,
        chat_id_set: !!AppConfig.telegram.chatId,
        token_preview: AppConfig.telegram.botToken
          ? AppConfig.telegram.botToken.slice(0, 8) + '***'
          : 'NOT SET',
      },
      check_interval_seconds: AppConfig.monitoring.checkIntervalSeconds,
    });
  });

  // ── Serve React dashboard in production ───────────────────
  const publicPath = path.join(__dirname, '..', 'public');
  if (fs.existsSync(publicPath)) {
    app.use(express.static(publicPath));
    app.get('*', (req, res, next) => {
      // Don't catch API routes
      if (req.path.startsWith('/api') || req.path === '/health') return next();
      res.sendFile(path.join(publicPath, 'index.html'));
    });
  } else {
    // No dashboard built — show a simple page
    app.get('/', (_, res) => {
      res.send(`
        <html><body style="font-family:monospace;padding:20px">
        <h2>🚀 Mostaql Monitor</h2>
        <p>API is running.</p>
        <ul>
          <li><a href="/health">GET /health</a></li>
          <li><a href="/api/status">GET /api/status</a></li>
          <li>POST /api/settings/test-telegram</li>
        </ul>
        </body></html>
      `);
    });
  }

  app.use(errorHandler);
  return app;
}
