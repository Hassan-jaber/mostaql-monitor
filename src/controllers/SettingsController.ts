import { Router, Request, Response, NextFunction } from 'express';
import { Database } from '../database/Database';
import { TelegramService } from '../services/TelegramService';
import { monitoringJob } from '../jobs/MonitoringJob';
import { requireAdmin } from '../middleware/adminAuth';
import { RunResult } from '../modules/types';

export const settingsRouter = Router();
const telegram = new TelegramService();

// Settings that may be edited through the API. Credentials are env-only;
// internal state keys (locks, health, scheduler state) are read-only.
const EDITABLE_KEYS = new Set(['monitoring_active', 'check_interval']);
const HIDDEN_PREFIXES = ['lock:', 'telegram_'];

settingsRouter.get('/', (_req, res, next) => {
  try {
    const out: Record<string, string> = {};
    for (const r of Database.getInstance().getAllSettings()) {
      if (HIDDEN_PREFIXES.some(p => r.key.startsWith(p))) continue;
      out[r.key] = r.value;
    }
    res.json(out);
  } catch (e) { next(e); }
});

settingsRouter.put('/', requireAdmin, (req: Request, res: Response, next: NextFunction) => {
  try {
    const updates = (req.body || {}) as Record<string, unknown>;
    const applied: string[] = [];
    const rejected: string[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (!EDITABLE_KEYS.has(key)) { rejected.push(key); continue; }
      Database.getInstance().setSetting(key, String(value));
      applied.push(key);
    }
    res.json({ success: rejected.length === 0, applied, rejected });
  } catch (e) { next(e); }
});

settingsRouter.post('/test-telegram', requireAdmin, async (_req, res, next) => {
  try {
    const result = await telegram.testConnection();
    res.status(result.success ? 200 : 502).json(result);
  } catch (e) { next(e); }
});

settingsRouter.post('/toggle-monitoring', requireAdmin, (req, res, next) => {
  try {
    const { active } = (req.body || {}) as { active?: boolean };
    Database.getInstance().setSetting('monitoring_active', active ? 'true' : 'false');
    res.json({ success: true, monitoring_active: !!active });
  } catch (e) { next(e); }
});

// ── Run check — called by cron-job.org (external mode) or manually ──
//
// Always returns a JSON body with an explicit `status`:
//   SUCCESS | SCRAPE_EMPTY | SCRAPE_FAILED | SCRAPE_BLOCKED | SCRAPE_PARSE_FAILED
//   TELEGRAM_FAILED | SKIPPED_ALREADY_RUNNING | SKIPPED_COOLDOWN | PAUSED | ERROR
//
// HTTP status: 200 by default, even on failure, so cron-job.org does not
// auto-disable the job during a Mostaql outage (success:false + status tell
// you what happened, and a Telegram health alert is sent). Add ?strict=1 to
// get 502/503/500 on failure instead.
settingsRouter.post('/run-check', requireAdmin, async (req, res, next) => {
  try {
    const result = await monitoringJob.runCheck('cron');
    res.status(httpStatusFor(result, isStrict(req))).json(result);
  } catch (e) { next(e); }
});

// Manual re-evaluation — only unsent no_match projects; never resends sent ones
settingsRouter.post('/re-evaluate', requireAdmin, async (req, res, next) => {
  try {
    const result = await monitoringJob.reEvaluateOldProjects();
    res.status(httpStatusFor(result, isStrict(req))).json(result);
  } catch (e) { next(e); }
});

function isStrict(req: Request): boolean {
  const v = String((req.query as Record<string, unknown>).strict || '');
  return v === '1' || v === 'true';
}

function httpStatusFor(r: RunResult, strict: boolean): number {
  if (!strict || r.success) return 200;
  switch (r.status) {
    case 'SCRAPE_BLOCKED':
    case 'SKIPPED_COOLDOWN':
      return 503;
    case 'SCRAPE_FAILED':
    case 'SCRAPE_PARSE_FAILED':
    case 'TELEGRAM_FAILED':
      return 502;
    default:
      return 500;
  }
}
