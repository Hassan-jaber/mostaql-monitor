import { MostaqlScraperService } from '../services/MostaqlScraperService';
import { KeywordMatcherService } from '../services/KeywordMatcherService';
import { TelegramService } from '../services/TelegramService';
import { ProjectRepository } from '../repositories/ProjectRepository';
import { Database } from '../database/Database';
import { logger } from '../utils/logger';

// ──────────────────────────────────────────────────────────────
// SchedulerState — persisted in DB so it survives process restarts.
// Hostinger restarts the Node process frequently; in-memory state
// is lost. Everything important is written to the DB immediately.
// ──────────────────────────────────────────────────────────────
export const SchedulerState = {
  processStartTime: new Date().toISOString(),

  // Write a key/value to settings table
  set(key: string, value: string): void {
    try {
      Database.getInstance().run(
        `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
        [key, value]
      );
    } catch { /* non-critical */ }
  },

  get(key: string): string | null {
    try {
      const row = Database.getInstance().queryOne<{ value: string }>(
        'SELECT value FROM settings WHERE key = ?', [key]
      );
      return row?.value ?? null;
    } catch { return null; }
  },

  markRunStart(): void {
    this.set('last_scheduler_run', new Date().toISOString());
    this.set('scheduler_running', 'true');
  },

  markRunEnd(scraped: number, matched: number, notified: number): void {
    this.set('scheduler_running', 'false');
    this.set('last_scheduler_stats', JSON.stringify({ scraped, matched, notified, at: new Date().toISOString() }));
    if (scraped > 0) this.set('last_successful_scrape', new Date().toISOString());
    if (notified > 0) this.set('last_telegram_notification', new Date().toISOString());
  },

  markRunError(msg: string): void {
    this.set('scheduler_running', 'false');
    this.set('last_scheduler_error', `${new Date().toISOString()}: ${msg}`);
  },
};

// ──────────────────────────────────────────────────────────────
// MonitoringJob
//
// Two modes controlled by SCHEDULER_MODE env var:
//
//   internal (default):
//     Uses setInterval. Works locally and on VPS.
//     On Hostinger shared hosting, the process may be killed —
//     the interval dies with it. Use external mode instead.
//
//   external:
//     setInterval is disabled. All checks are triggered by
//     POST /api/settings/run-check from an external cron service
//     (cron-job.org, UptimeRobot, GitHub Actions, etc.)
//     This is the RECOMMENDED mode for Hostinger Business Hosting.
// ──────────────────────────────────────────────────────────────
export class MonitoringJob {
  private scraper = new MostaqlScraperService();
  private matcher = new KeywordMatcherService();
  private telegram = new TelegramService();
  private repo = new ProjectRepository();
  private timer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  private get mode(): 'internal' | 'external' {
    return (process.env.SCHEDULER_MODE || 'internal') as 'internal' | 'external';
  }

  async start(): Promise<void> {
    const interval = this.getInterval();

    // Record process start in DB
    SchedulerState.set('process_start_time', SchedulerState.processStartTime);
    SchedulerState.set('scheduler_mode', this.mode);
    SchedulerState.set('scheduler_running', 'false');

    logger.info(`⚙️  Scheduler mode: ${this.mode.toUpperCase()}`);

    // Always run one immediate check on startup
    logger.info('▶️  Running immediate startup check...');
    await this.runCheck();

    if (this.mode === 'external') {
      logger.info('⏸  Internal scheduler DISABLED — waiting for external cron triggers');
      logger.info('   Trigger URL: POST /api/settings/run-check');
      logger.info('   Set up a cron job at cron-job.org or similar to call this every 60s');
      return;
    }

    // Internal mode — setInterval
    const ms = interval * 1000;
    this.timer = setInterval(async () => {
      if (this.isRunning) {
        logger.debug('⏭  Skipping — previous check still running');
        return;
      }
      await this.runCheck();
    }, ms);

    // DO NOT call timer.unref() — process must stay alive
    logger.info('Monitoring timer created');
    logger.info(`Interval = ${interval}s`);
    logger.info(`✅ Internal scheduler started (every ${interval}s)`);

    // Heartbeat watchdog — checks every 5 min if the timer is still alive
    // and logs a warning if no run happened in 3× the expected interval
    setInterval(() => {
      const last = SchedulerState.get('last_scheduler_run');
      if (!last) return;
      const diffMs = Date.now() - new Date(last).getTime();
      const maxAllowed = interval * 3 * 1000;
      if (diffMs > maxAllowed) {
        const mins = Math.round(diffMs / 60000);
        logger.error(`🚨 SCHEDULER STALLED: no run in ${mins} minutes (expected every ${interval}s)`);
        SchedulerState.set('scheduler_stalled', `true — last run ${mins}m ago at ${last}`);
        Database.getInstance().run(
          'INSERT INTO system_logs (level, category, message) VALUES (?, ?, ?)',
          ['error', 'scheduler', `Scheduler stalled: no run in ${mins} minutes`]
        );
      } else {
        SchedulerState.set('scheduler_stalled', 'false');
      }
    }, 5 * 60 * 1000); // check every 5 minutes
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    SchedulerState.set('scheduler_running', 'false');
    logger.info('🛑 Monitoring stopped');
  }

  async runCheck(triggeredBy: 'scheduler' | 'manual' | 'startup' = 'scheduler'): Promise<{
    scanned: number; newCount: number; matched: number; notified: number;
  }> {
    if (this.isRunning) {
      logger.debug('⏭  runCheck skipped — already running');
      return { scanned: 0, newCount: 0, matched: 0, notified: 0 };
    }
    this.isRunning = true;
    SchedulerState.markRunStart();

    const startTime = Date.now();
    let scanned = 0, newCount = 0, matchedCount = 0, notifiedCount = 0;

    try {
      // Check pause state
      let isActive = true;
      try {
        const row = Database.getInstance().queryOne<{ value: string }>(
          "SELECT value FROM settings WHERE key = 'monitoring_active'"
        );
        isActive = row?.value !== 'false';
      } catch { /* DB unavailable — keep running */ }

      if (!isActive) {
        logger.info('⏸  Monitoring paused — skipping check');
        SchedulerState.markRunEnd(0, 0, 0);
        return { scanned: 0, newCount: 0, matched: 0, notified: 0 };
      }

      logger.info(`🔍 [${triggeredBy.toUpperCase()}] Checking Mostaql...`);

      const projects = await this.scraper.fetchLatestProjects();
      scanned = projects.length;

      if (projects.length === 0) {
        logger.warn('⚠️  0 projects returned — Mostaql may be blocking');
        SchedulerState.markRunEnd(0, 0, 0);
        Database.getInstance().run(
          'INSERT INTO system_logs (level, category, message) VALUES (?, ?, ?)',
          ['warn', 'scraping', '0 projects returned from Mostaql']
        );
        return { scanned: 0, newCount: 0, matched: 0, notified: 0 };
      }

      for (const project of projects) {
        let alreadyExists = false;
        try { alreadyExists = this.repo.exists(project.project_id); } catch { /* ignore */ }
        if (alreadyExists) continue;
        newCount++;

        const { matched, keywords } = this.matcher.matchProject(project);

        if (!matched) {
          try {
            this.repo.save({
              project_id: project.project_id, title: project.title, url: project.url,
              budget: project.budget || 'غير محدد', description: project.description || '',
              skills: JSON.stringify(project.skills || []),
              classification: 'no_match', reason: 'No keywords matched', matched_keywords: '[]',
            });
          } catch { /* ignore */ }
          continue;
        }

        matchedCount++;

        try {
          this.repo.save({
            project_id: project.project_id, title: project.title, url: project.url,
            budget: project.budget || 'غير محدد', description: project.description || '',
            skills: JSON.stringify(project.skills || []),
            classification: 'matched',
            reason: `Matched: ${keywords.join(', ')}`,
            matched_keywords: JSON.stringify(keywords),
          });
        } catch { /* ignore */ }

        const sent = await this.telegram.sendMatchNotification(project, keywords);
        if (sent) notifiedCount++;

        try {
          Database.getInstance().run(
            'INSERT INTO system_logs (level, category, message, metadata) VALUES (?, ?, ?, ?)',
            ['info', 'matching', `Matched: ${project.title}`,
              JSON.stringify({ keywords, sent, triggeredBy })]
          );
        } catch { /* ignore */ }
      }

      const elapsed = Date.now() - startTime;
      logger.info(`📊 [${triggeredBy.toUpperCase()}] Done in ${elapsed}ms — scanned: ${scanned}, new: ${newCount}, matched: ${matchedCount}, notified: ${notifiedCount}`);

      // Log scheduler execution to DB
      Database.getInstance().run(
        'INSERT INTO system_logs (level, category, message, metadata) VALUES (?, ?, ?, ?)',
        ['info', 'scheduler',
          `Check complete (${triggeredBy})`,
          JSON.stringify({ scanned, newCount, matched: matchedCount, notified: notifiedCount, elapsed_ms: elapsed })]
      );

      SchedulerState.markRunEnd(scanned, matchedCount, notifiedCount);
      return { scanned, newCount, matched: matchedCount, notified: notifiedCount };

    } catch (err: any) {
      logger.error(`❌ runCheck error: ${err.message}`);
      SchedulerState.markRunError(err.message);
      Database.getInstance().run(
        'INSERT INTO system_logs (level, category, message) VALUES (?, ?, ?)',
        ['error', 'scheduler', `runCheck error: ${err.message}`]
      );
      return { scanned: 0, newCount: 0, matched: 0, notified: 0 };
    } finally {
      this.isRunning = false;
    }
  }

  async reEvaluateOldProjects(): Promise<void> {
    logger.info('🔄 Re-evaluating old no_match projects...');
    let old: any[] = [];
    try {
      old = Database.getInstance().queryAll(
        "SELECT project_id, title, url, budget, description, skills FROM projects WHERE classification = 'no_match'"
      );
    } catch { logger.warn('Cannot read DB for re-evaluation'); return; }

    logger.info(`Found ${old.length} no_match projects`);
    let matched = 0, notified = 0;

    for (const row of old) {
      const project = {
        project_id: row.project_id, title: row.title, url: row.url,
        budget: row.budget, description: row.description,
        skills: (() => { try { return JSON.parse(row.skills) || []; } catch { return []; } })(),
      };
      const { matched: isMatch, keywords } = this.matcher.matchProject(project);
      if (!isMatch) continue;
      matched++;
      logger.info(`🔄 Re-matched: "${project.title}"`);
      try {
        Database.getInstance().run(
          "UPDATE projects SET classification = 'matched', reason = ?, matched_keywords = ? WHERE project_id = ?",
          [`Re-matched: ${keywords.join(', ')}`, JSON.stringify(keywords), project.project_id]
        );
      } catch { /* ignore */ }
      const sent = await this.telegram.sendMatchNotification(project, keywords);
      if (sent) notified++;
    }

    logger.info(`✅ Re-evaluation done — re-matched: ${matched}, notified: ${notified}`);
  }

  private getInterval(): number {
    let val = parseInt(process.env.CHECK_INTERVAL_SECONDS || '60', 10);
    try {
      const row = Database.getInstance().queryOne<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'check_interval'"
      );
      if (row?.value) val = parseInt(row.value, 10);
    } catch { /* use env var */ }
    return isNaN(val) || val < 10 ? 60 : val;
  }
}
