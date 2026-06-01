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

export function createApp(): Application {
  const app = express();

  app.use(cors({ origin: '*' }));
  app.use(express.json());
  app.use(requestLogger);

  app.use('/api/projects', projectRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/logs', logsRouter);
  app.use('/api/stats', statsRouter);

  app.get('/health', (_, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Serve React dashboard in production
  const publicPath = path.join(__dirname, '..', 'public');
  if (fs.existsSync(publicPath)) {
    app.use(express.static(publicPath));
    app.get('*', (_, res) => {
      res.sendFile(path.join(publicPath, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}
