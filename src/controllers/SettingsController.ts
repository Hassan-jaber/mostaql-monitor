import { Router, Request, Response, NextFunction } from 'express';
import { Database } from '../database/Database';
import { TelegramService } from '../services/TelegramService';
import { MonitoringJob } from '../jobs/MonitoringJob';
import { AppConfig } from '../config/AppConfig';

export const settingsRouter = Router();
const telegram = new TelegramService();

settingsRouter.get('/', (_req, res, next) => {
  try {
    let rows: { key: string; value: string }[] = [];
    try {
      rows = Database.getInstance().queryAll<{ key: string; value: string }>(
        'SELECT key, value FROM settings'
      );
    } catch {
      rows = [
        { key: 'telegram_bot_token', value: AppConfig.telegram.botToken ? '***set***' : '' },
        { key: 'telegram_chat_id', value: AppConfig.telegram.chatId },
        { key: 'check_interval', value: String(AppConfig.monitoring.checkIntervalSeconds) },
        { key: 'monitoring_active', value: 'true' },
        { key: 'scheduler_mode', value: process.env.SCHEDULER_MODE || 'internal' },
      ];
    }
    const out: Record<string, string> = {};
    for (const r of rows) {
      out[r.key] = r.key === 'telegram_bot_token' && r.value && r.value.length > 5
        ? r.value.slice(0, 8) + '***'
        : r.value;
    }
    res.json(out);
  } catch (e) { next(e); }
});

settingsRouter.put('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const updates = req.body as Record<string, string>;
    for (const [key, value] of Object.entries(updates)) {
      Database.getInstance().run(
        `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
        [key, value]
      );
    }
    res.json({ success: true });
  } catch (e) { next(e); }
});

settingsRouter.post('/test-telegram', async (_req, res, next) => {
  try {
    const result = await telegram.testConnection();
    res.json(result);
  } catch (e) { next(e); }
});

settingsRouter.post('/toggle-monitoring', (req, res, next) => {
  try {
    const { active } = req.body as { active: boolean };
    Database.getInstance().run(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('monitoring_active', ?)`,
      [active ? 'true' : 'false']
    );
    res.json({ success: true, monitoring_active: active });
  } catch (e) { next(e); }
});

// ── Run check — called by external cron OR manually ────────
// This is the PRIMARY trigger in external scheduler mode.
settingsRouter.post('/run-check', async (_req, res, next) => {
  try {
    const job = new MonitoringJob();
    // Run synchronously so the response includes results
    const result = await job.runCheck('manual');
    res.json({ success: true, ...result });
  } catch (e) { next(e); }
});
