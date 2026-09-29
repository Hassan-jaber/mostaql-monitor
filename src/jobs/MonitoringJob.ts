import crypto from 'crypto';
import { MostaqlScraperService } from '../services/MostaqlScraperService';
import { KeywordMatcherService } from '../services/KeywordMatcherService';
import { TelegramService } from '../services/TelegramService';
import { ProjectRepository } from '../repositories/ProjectRepository';
import { Database } from '../database/Database';
import { AppConfig } from '../config/AppConfig';
import { logger } from '../utils/logger';
import { checkProjectAge, parseUtc } from '../utils/projectAge';
import { errorMessage } from '../utils/redact';
import { RunResult, RunStatus, ScrapedProject } from '../modules/types';

// ──────────────────────────────────────────────────────────────
// Persistent scheduler/health state (settings table, survives restarts)
// ──────────────────────────────────────────────────────────────
export const SchedulerState = {
  processStartTime: new Date().toISOString(),

  set(key: string, value: string): void {
    try { Database.getInstance().setSetting(key, value); } catch { /* non-critical */ }
  },

  get(key: string): string | null {
    try { return Database.getInstance().getSetting(key); } catch { return null; }
  },

  del(key: string): void {
    try { Database.getInstance().deleteSetting(key); } catch { /* non-critical */ }
  },
};

const LOCK_NAME = 'monitoring_run';
const FAILING_STATUSES: RunStatus[] = ['SCRAPE_FAILED', 'SCRAPE_BLOCKED', 'SCRAPE_PARSE_FAILED', 'SKIPPED_COOLDOWN'];

type Trigger = 'scheduler' | 'manual' | 'startup' | 'cron' | 're-evaluate';

export class MonitoringJob {
  private scraper = new MostaqlScraperService();
  private matcher = new KeywordMatcherService();
  private telegram = new TelegramService();
  private repo = new ProjectRepository();
  private timer: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  /** One in-flight run per process, shared by every caller. */
  private static inFlight: Promise<RunResult> | null = null;

  get mode(): 'internal' | 'external' { return AppConfig.monitoring.schedulerMode; }

  getScraper(): MostaqlScraperService { return this.scraper; }

  async start(): Promise<void> {
    SchedulerState.set('process_start_time', SchedulerState.processStartTime);
    SchedulerState.set('scheduler_mode', this.mode);
    logger.info(`⚙️  Scheduler mode: ${this.mode.toUpperCase()}`);

    if (AppConfig.monitoring.runOnStartup) {
      logger.info('▶️  Running startup check...');
      const r = await this.runCheck('startup');
      logger.info(`Startup check → ${r.status}`);
    }

    if (this.mode === 'external') {
      logger.info('⏸  Internal scheduler DISABLED — cron-job.org must POST /api/settings/run-check');
      return;
    }

    const interval = this.getInterval();
    this.timer = setInterval(() => { void this.runCheck('scheduler'); }, interval * 1000);
    logger.info(`✅ Internal scheduler started (every ${interval}s)`);

    this.watchdog = setInterval(() => {
      const last = SchedulerState.get('last_scheduler_run');
      if (!last) return;
      const diffMs = Date.now() - new Date(last).getTime();
      if (diffMs > interval * 3 * 1000) {
        const mins = Math.round(diffMs / 60000);
        logger.error(`🚨 SCHEDULER STALLED: no run in ${mins} minutes`);
        SchedulerState.set('scheduler_stalled', `true — last run ${mins}m ago`);
      } else {
        SchedulerState.set('scheduler_stalled', 'false');
      }
    }, 5 * 60 * 1000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    logger.info('🛑 Monitoring stopped');
  }

  isRunning(): boolean { return MonitoringJob.inFlight !== null; }

  // ── Main entry point ───────────────────────────────────────

  async runCheck(triggeredBy: Trigger = 'scheduler'): Promise<RunResult> {
    if (MonitoringJob.inFlight) {
      logger.info(`⏭  runCheck (${triggeredBy}) skipped — a run is already in progress in this process`);
      return this.result(triggeredBy, 'SKIPPED_ALREADY_RUNNING', Date.now(), {
        success: true, message: 'Another check is already running; this request did not start a second one.',
      });
    }
    const p = this.runExclusive(triggeredBy);
    MonitoringJob.inFlight = p;
    try { return await p; } finally { MonitoringJob.inFlight = null; }
  }

  private async runExclusive(triggeredBy: Trigger): Promise<RunResult> {
    const started = Date.now();
    const db = Database.getInstance();

    // Without a working store we cannot tell new projects from old ones,
    // so notifying would spam duplicates. Fail loudly instead.
    if (!db.isReady()) {
      const r = this.result(triggeredBy, 'ERROR', started, { error: 'Database is not initialized — refusing to run (duplicate-notification risk)' });
      logger.error(`❌ ${r.error}`);
      return r;
    }

    const owner = crypto.randomUUID();
    const ttl = AppConfig.monitoring.runLockTtlSeconds * 1000;
    let locked = false;
    try { locked = db.tryAcquireLock(LOCK_NAME, owner, ttl); } catch (e: any) {
      return this.result(triggeredBy, 'ERROR', started, { error: `Lock error: ${errorMessage(e)}` });
    }
    if (!locked) {
      logger.info(`⏭  runCheck (${triggeredBy}) skipped — another worker holds the run lock`);
      return this.result(triggeredBy, 'SKIPPED_ALREADY_RUNNING', started, {
        success: true, message: 'Another check is already running (another worker holds the lock).',
      });
    }

    SchedulerState.set('last_scheduler_run', new Date().toISOString());
    SchedulerState.set('scheduler_running', 'true');

    let result: RunResult;
    try {
      result = triggeredBy === 're-evaluate'
        ? await this.doReEvaluate(started)
        : await this.doRun(triggeredBy, started);
    } catch (e: any) {
      result = this.result(triggeredBy, 'ERROR', started, { error: errorMessage(e) });
      logger.error(`❌ runCheck internal error: ${result.error}`);
    } finally {
      SchedulerState.set('scheduler_running', 'false');
      db.releaseLock(LOCK_NAME, owner);
    }

    this.persistRunState(result);
    await this.handleHealthAlerts(result);
    db.flush();
    return result;
  }

  private async doRun(triggeredBy: Trigger, started: number): Promise<RunResult> {
    const db = Database.getInstance();

    if (db.getSetting('monitoring_active') === 'false') {
      logger.info('⏸  Monitoring paused (monitoring_active=false)');
      return this.result(triggeredBy, 'PAUSED', started, { success: true, message: 'Monitoring is paused (settings.monitoring_active=false).' });
    }

    logger.info(`🔍 [${triggeredBy.toUpperCase()}] Checking Mostaql...`);
    const scrape = await this.scraper.fetchLatestProjects();
    const scrapeInfo = { status: scrape.status, transport: scrape.transport, attempts: scrape.attempts };

    if (scrape.cooldown_until) {
      return this.result(triggeredBy, 'SKIPPED_COOLDOWN', started, {
        scrape: scrapeInfo, error: scrape.error,
        message: `Mostaql blocked direct requests from this server. Paused until ${scrape.cooldown_until}. Configure SCRAPER_RELAY_URL or SCRAPER_PROXY_URL.`,
      });
    }
    if (scrape.status !== 'SCRAPE_SUCCESS' && scrape.status !== 'SCRAPE_EMPTY') {
      logger.error(`❌ Scrape failed: ${scrape.status} — ${scrape.error}`);
      return this.result(triggeredBy, scrape.status, started, { scrape: scrapeInfo, error: scrape.error });
    }

    const counts = { scanned: scrape.projects.length, newCount: 0, matched: 0, notified: 0, notifyFailed: 0, retried: 0, skippedOld: 0 };
    const attemptedNow = new Set<string>();

    for (const project of scrape.projects) {
      // Throws if the DB is broken → whole run becomes ERROR (never "new")
      if (this.repo.exists(project.project_id)) continue;
      counts.newCount++;

      const { matched, keywords } = this.matcher.matchProject(project);
      const base = this.baseRow(project, keywords);

      if (!matched) {
        this.repo.save({ ...base, classification: 'no_match', reason: 'No keywords matched', notify_status: null });
        continue;
      }
      counts.matched++;

      const age = checkProjectAge(project.project_id, project.title, project.posted_at ?? null);
      if (!age.allowed) {
        counts.skippedOld++;
        this.repo.save({ ...base, classification: 'skipped_old', reason: age.reason, notify_status: 'skipped' });
        continue;
      }

      // Persist as PENDING first; only a confirmed Telegram delivery flips it to 'sent'.
      const inserted = this.repo.save({ ...base, classification: 'matched', reason: `Matched: ${keywords.join(', ')}`, notify_status: 'pending' });
      if (!inserted) continue; // another worker got it first

      attemptedNow.add(project.project_id);
      const sent = await this.telegram.sendMatchNotification(project, keywords);
      this.repo.recordNotifyResult(project.project_id, sent.ok, sent.error);
      if (sent.ok) counts.notified++; else counts.notifyFailed++;
      Database.getInstance().addLog(sent.ok ? 'info' : 'error', 'matching', `Matched: ${project.title}`, {
        project_id: project.project_id, keywords, sent: sent.ok, error: sent.error, triggeredBy, age_minutes: age.ageMinutes,
      });
    }

    // ── Retry notifications that failed on earlier runs ──────
    const retryResult = await this.retryPendingNotifications(attemptedNow);
    counts.retried = retryResult.attempted;
    counts.notified += retryResult.sent;
    counts.notifyFailed += retryResult.failed;

    const status: RunStatus = counts.notifyFailed > 0
      ? 'TELEGRAM_FAILED'
      : scrape.status === 'SCRAPE_EMPTY' ? 'SCRAPE_EMPTY' : 'SUCCESS';

    const r = this.result(triggeredBy, status, started, { ...counts, scrape: scrapeInfo });
    if (status === 'TELEGRAM_FAILED') r.error = 'One or more Telegram notifications failed; they will be retried on the next runs.';
    logger.info(
      `📊 [${triggeredBy.toUpperCase()}] ${status} in ${r.duration_ms}ms via ${scrape.transport} — ` +
      `scanned: ${r.scanned}, new: ${r.newCount}, matched: ${r.matched}, notified: ${r.notified}, ` +
      `failed: ${r.notifyFailed}, retried: ${r.retried}, skipped_old: ${r.skippedOld}`
    );
    return r;
  }

  private async retryPendingNotifications(exclude: Set<string>): Promise<{ attempted: number; sent: number; failed: number }> {
    const out = { attempted: 0, sent: 0, failed: 0 };
    const since = new Date(Date.now() - AppConfig.monitoring.notifyRetryWindowMinutes * 60000).toISOString();
    const rows = this.repo.getRetryable(since, AppConfig.monitoring.notifyMaxAttempts);

    for (const row of rows) {
      if (exclude.has(row.project_id)) continue;
      const keywords = safeJsonArray(row.matched_keywords);
      const project: ScrapedProject = {
        project_id: row.project_id, title: row.title, url: row.url, budget: row.budget,
        description: row.description, skills: safeJsonArray(row.skills), posted_at: row.posted_at ?? undefined,
      };
      out.attempted++;
      logger.info(`🔁 Retrying notification ${row.project_id} (attempt ${row.notify_attempts + 1}/${AppConfig.monitoring.notifyMaxAttempts})`);
      const sent = await this.telegram.sendMatchNotification(project, keywords);
      this.repo.recordNotifyResult(row.project_id, sent.ok, sent.error);
      if (sent.ok) out.sent++; else out.failed++;
      if (!sent.ok && row.notify_attempts + 1 >= AppConfig.monitoring.notifyMaxAttempts) {
        this.repo.markNotifySkipped(row.project_id, `Gave up after ${row.notify_attempts + 1} attempts: ${sent.error}`);
      }
    }
    return out;
  }

  // ── Manual re-evaluation of unsent no_match projects ───────

  async reEvaluateOldProjects(): Promise<RunResult> {
    return this.runCheck('re-evaluate');
  }

  private async doReEvaluate(started: number): Promise<RunResult> {
    logger.info('🔄 Re-evaluating unsent no_match projects...');
    const rows = Database.getInstance()
      .queryAll<any>(`SELECT * FROM projects WHERE classification = 'no_match' AND sent_at IS NULL`)
      .filter(r => r.classification === 'no_match' && !r.sent_at);

    let matched = 0, notified = 0, failed = 0, skippedOld = 0;
    for (const row of rows) {
      const project: ScrapedProject = {
        project_id: row.project_id, title: row.title, url: row.url, budget: row.budget,
        description: row.description, skills: safeJsonArray(row.skills),
        posted_at: row.posted_at || toIso(row.created_at),
      };
      const { matched: isMatch, keywords } = this.matcher.matchProject(project);
      if (!isMatch) continue;

      const age = checkProjectAge(project.project_id, project.title, project.posted_at ?? null);
      if (!age.allowed) {
        skippedOld++;
        this.repo.updateClassification(project.project_id, 'skipped_old', age.reason, JSON.stringify(keywords), 'skipped');
        continue;
      }
      matched++;
      this.repo.updateClassification(project.project_id, 'matched', `Re-matched: ${keywords.join(', ')}`, JSON.stringify(keywords), 'pending');
      const sent = await this.telegram.sendMatchNotification(project, keywords);
      this.repo.recordNotifyResult(project.project_id, sent.ok, sent.error);
      if (sent.ok) notified++; else failed++;
    }
    logger.info(`✅ Re-evaluation done — re-matched: ${matched}, notified: ${notified}, failed: ${failed}, skipped_old: ${skippedOld}`);
    return this.result('re-evaluate', failed > 0 ? 'TELEGRAM_FAILED' : 'SUCCESS', started, {
      scanned: rows.length, matched, notified, notifyFailed: failed, skippedOld,
    });
  }

  // ── State & alerts ─────────────────────────────────────────

  private persistRunState(r: RunResult): void {
    if (r.status === 'SKIPPED_ALREADY_RUNNING') return;
    const now = new Date().toISOString();
    SchedulerState.set('last_run_result', JSON.stringify(r));
    SchedulerState.set('last_scheduler_stats', JSON.stringify({
      status: r.status, scraped: r.scanned, matched: r.matched, notified: r.notified, at: now,
    }));

    const scrapeOk = r.scrape && (r.scrape.status === 'SCRAPE_SUCCESS' || r.scrape.status === 'SCRAPE_EMPTY');
    if (scrapeOk) {
      SchedulerState.set('last_successful_scrape', now);
      SchedulerState.set('last_successful_scrape_count', String(r.scanned));
    }
    if (r.notified > 0) SchedulerState.set('last_telegram_notification', now);

    if (r.status === 'SUCCESS' || r.status === 'SCRAPE_EMPTY' || r.status === 'PAUSED') {
      SchedulerState.set('last_error_cleared_at', now);
    } else if (r.error) {
      SchedulerState.set('last_scheduler_error', `${now}: [${r.status}] ${r.error}`);
    }
    if (r.status === 'TELEGRAM_FAILED') SchedulerState.set('last_telegram_error', `${now}: ${r.error}`);

    try {
      Database.getInstance().addLog(r.success ? 'info' : 'error', 'scheduler', `Check ${r.status} (${r.triggered_by})`, {
        scanned: r.scanned, newCount: r.newCount, matched: r.matched, notified: r.notified,
        notifyFailed: r.notifyFailed, retried: r.retried, skippedOld: r.skippedOld,
        duration_ms: r.duration_ms, transport: r.scrape?.transport, error: r.error,
      });
    } catch { /* non-critical */ }
  }

  /** Telegram alert when scraping has been failing for a while, and on recovery. */
  private async handleHealthAlerts(r: RunResult): Promise<void> {
    const afterMin = AppConfig.monitoring.alertAfterMinutes;
    if (afterMin <= 0 || r.status === 'SKIPPED_ALREADY_RUNNING' || r.status === 'PAUSED' || r.triggered_by === 're-evaluate') return;

    const now = Date.now();
    const failing = FAILING_STATUSES.includes(r.status);

    if (failing) {
      let since = SchedulerState.get('scrape_failing_since');
      if (!since) { since = new Date(now).toISOString(); SchedulerState.set('scrape_failing_since', since); }
      const failingMin = (now - new Date(since).getTime()) / 60000;
      const lastAlert = SchedulerState.get('health_alert_sent_at');
      const repeatDue = !lastAlert || now - new Date(lastAlert).getTime() > AppConfig.monitoring.alertRepeatHours * 3600000;
      if (failingMin >= afterMin && repeatDue) {
        const lastOk = SchedulerState.get('last_successful_scrape') || 'never';
        const text =
          `⚠️ <b>Mostaql Monitor: scraping is failing</b>\n\n` +
          `Status: <code>${r.status}</code>\n` +
          `Failing since: ${since}\n` +
          `Last successful scrape: ${lastOk}\n` +
          (r.error ? `Details: ${escapeHtml(r.error.slice(0, 600))}\n` : '') +
          (r.message ? `\n${escapeHtml(r.message)}` : '');
        const sent = await this.telegram.sendAlert(text);
        if (sent.ok) SchedulerState.set('health_alert_sent_at', new Date(now).toISOString());
        else logger.error(`Health alert could not be sent: ${sent.error}`);
      }
      return;
    }

    // Scrape worked this run → clear the incident, announce recovery if we alerted
    if (r.scrape && (r.scrape.status === 'SCRAPE_SUCCESS' || r.scrape.status === 'SCRAPE_EMPTY')) {
      const alerted = SchedulerState.get('health_alert_sent_at');
      const since = SchedulerState.get('scrape_failing_since');
      if (alerted) {
        await this.telegram.sendAlert(
          `✅ <b>Mostaql Monitor recovered</b>\nScraping works again via <code>${r.scrape.transport}</code> (${r.scanned} projects). Outage started ${since}.`
        );
      }
      SchedulerState.del('scrape_failing_since');
      SchedulerState.del('health_alert_sent_at');
    }
  }

  // ── Helpers ────────────────────────────────────────────────

  private baseRow(project: ScrapedProject, keywords: string[]) {
    return {
      project_id: project.project_id,
      title: project.title,
      url: project.url,
      budget: project.budget || 'غير محدد',
      description: project.description || '',
      skills: JSON.stringify(project.skills || []),
      matched_keywords: JSON.stringify(keywords),
      posted_at: project.posted_at ?? null,
    };
  }

  private result(triggeredBy: string, status: RunStatus, started: number, extra: Partial<RunResult> = {}): RunResult {
    const successStatuses: RunStatus[] = ['SUCCESS', 'SCRAPE_EMPTY', 'PAUSED', 'SKIPPED_ALREADY_RUNNING'];
    return {
      success: successStatuses.includes(status),
      status,
      triggered_by: triggeredBy,
      scanned: 0, newCount: 0, matched: 0, notified: 0, notifyFailed: 0, retried: 0, skippedOld: 0,
      duration_ms: Date.now() - started,
      ...extra,
    };
  }

  private getInterval(): number {
    let val = AppConfig.monitoring.checkIntervalSeconds;
    const fromDb = parseInt(SchedulerState.get('check_interval') || '', 10);
    if (Number.isFinite(fromDb) && fromDb >= 10) val = fromDb;
    return val;
  }
}

/** Process-wide singleton shared by index.ts and the HTTP controllers. */
export const monitoringJob = new MonitoringJob();

function safeJsonArray(v: any): string[] {
  try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; }
}

function toIso(v: string | null | undefined): string | undefined {
  const d = parseUtc(v);
  return d ? d.toISOString() : undefined;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
