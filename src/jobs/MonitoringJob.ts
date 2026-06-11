import { MostaqlScraperService } from '../services/MostaqlScraperService';
import { KeywordMatcherService } from '../services/KeywordMatcherService';
import { TelegramService } from '../services/TelegramService';
import { ProjectRepository } from '../repositories/ProjectRepository';
import { Database } from '../database/Database';
import { logger } from '../utils/logger';
import { checkProjectAge } from '../utils/projectAge';

export const SchedulerState = {
  processStartTime: new Date().toISOString(),

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

    SchedulerState.set('process_start_time', SchedulerState.processStartTime);
    SchedulerState.set('scheduler_mode', this.mode);
    SchedulerState.set('scheduler_running', 'false');

    logger.info(`⚙️  Scheduler mode: ${this.mode.toUpperCase()}`);

    logger.info('▶️  Running immediate startup check...');
    await this.runCheck('startup');

    if (this.mode === 'external') {
      logger.info('⏸  Internal scheduler DISABLED — use cron-job.org to POST /api/settings/run-check');
      return;
    }

    const ms = interval * 1000;
    this.timer = setInterval(async () => {
      if (this.isRunning) { logger.debug('⏭  Skipping — still running'); return; }
      await this.runCheck('scheduler');
    }, ms);

    // DO NOT call timer.unref()
    logger.info('Monitoring timer created');
    logger.info(`Interval = ${interval}s`);
    logger.info(`✅ Internal scheduler started (every ${interval}s)`);

    setInterval(() => {
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
    SchedulerState.set('scheduler_running', 'false');
    logger.info('🛑 Monitoring stopped');
  }

  async runCheck(triggeredBy: 'scheduler' | 'manual' | 'startup' = 'scheduler'): Promise<{
    scanned: number; newCount: number; matched: number; notified: number; skippedOld: number;
  }> {
    if (this.isRunning) {
      logger.debug('⏭  runCheck skipped — already running');
      return { scanned: 0, newCount: 0, matched: 0, notified: 0, skippedOld: 0 };
    }
    this.isRunning = true;
    SchedulerState.markRunStart();

    const startTime = Date.now();
    let scanned = 0, newCount = 0, matchedCount = 0, notifiedCount = 0, skippedOldCount = 0;

    try {
      let isActive = true;
      try {
        const row = Database.getInstance().queryOne<{ value: string }>(
          "SELECT value FROM settings WHERE key = 'monitoring_active'"
        );
        isActive = row?.value !== 'false';
      } catch { /* keep running */ }

      if (!isActive) {
        logger.info('⏸  Monitoring paused');
        SchedulerState.markRunEnd(0, 0, 0);
        return { scanned: 0, newCount: 0, matched: 0, notified: 0, skippedOld: 0 };
      }

      logger.info(`🔍 [${triggeredBy.toUpperCase()}] Checking Mostaql...`);
      const projects = await this.scraper.fetchLatestProjects();
      scanned = projects.length;

      if (projects.length === 0) {
        logger.warn('⚠️  0 projects returned');
        SchedulerState.markRunEnd(0, 0, 0);
        return { scanned: 0, newCount: 0, matched: 0, notified: 0, skippedOld: 0 };
      }

      for (const project of projects) {
        // ── DUPLICATE GUARD ────────────────────────────────────
        let alreadyExists = false;
        try { alreadyExists = this.repo.exists(project.project_id); } catch { /* ignore */ }
        if (alreadyExists) continue;
        newCount++;

        // ── KEYWORD MATCH ──────────────────────────────────────
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

        // ── AGE CHECK — before any notification ───────────────
        const ageCheck = checkProjectAge(
          project.project_id,
          project.title,
          project.posted_at ?? null
        );

        if (!ageCheck.allowed) {
          skippedOldCount++;
          // Save to DB but mark as skipped_old so we don't recheck it
          try {
            this.repo.save({
              project_id: project.project_id, title: project.title, url: project.url,
              budget: project.budget || 'غير محدد', description: project.description || '',
              skills: JSON.stringify(project.skills || []),
              classification: 'skipped_old',
              reason: ageCheck.reason,
              matched_keywords: JSON.stringify(keywords),
            });
          } catch { /* ignore */ }
          try {
            Database.getInstance().run(
              'INSERT INTO system_logs (level, category, message, metadata) VALUES (?, ?, ?, ?)',
              ['info', 'age_filter',
                `Skipped project because age exceeds ${ageCheck.maxMinutes} minutes`,
                JSON.stringify({
                  project_id: project.project_id,
                  title: project.title,
                  posted_at: project.posted_at,
                  age_minutes: ageCheck.ageMinutes,
                  max_minutes: ageCheck.maxMinutes,
                })]
            );
          } catch { /* ignore */ }
          continue;
        }

        // ── SAVE (before send — prevents resend on retry) ──────
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

        // ── SEND TELEGRAM ──────────────────────────────────────
        const sent = await this.telegram.sendMatchNotification(project, keywords);
        if (sent) notifiedCount++;

        try {
          Database.getInstance().run(
            'INSERT INTO system_logs (level, category, message, metadata) VALUES (?, ?, ?, ?)',
            ['info', 'matching', `Matched: ${project.title}`,
              JSON.stringify({ keywords, sent, triggeredBy, age_minutes: ageCheck.ageMinutes })]
          );
        } catch { /* ignore */ }
      }

      const elapsed = Date.now() - startTime;
      logger.info(
        `📊 [${triggeredBy.toUpperCase()}] Done in ${elapsed}ms — ` +
        `scanned: ${scanned}, new: ${newCount}, matched: ${matchedCount}, ` +
        `notified: ${notifiedCount}, skipped_old: ${skippedOldCount}`
      );

      try {
        Database.getInstance().run(
          'INSERT INTO system_logs (level, category, message, metadata) VALUES (?, ?, ?, ?)',
          ['info', 'scheduler', `Check complete (${triggeredBy})`,
            JSON.stringify({ scanned, newCount, matched: matchedCount, notified: notifiedCount, skippedOld: skippedOldCount, elapsed_ms: elapsed })]
        );
      } catch { /* ignore */ }

      SchedulerState.markRunEnd(scanned, matchedCount, notifiedCount);
      return { scanned, newCount, matched: matchedCount, notified: notifiedCount, skippedOld: skippedOldCount };

    } catch (err: any) {
      logger.error(`❌ runCheck error: ${err.message}`);
      SchedulerState.markRunError(err.message);
      return { scanned: 0, newCount: 0, matched: 0, notified: 0, skippedOld: 0 };
    } finally {
      this.isRunning = false;
    }
  }

  // ── reEvaluateOldProjects ──────────────────────────────────
  // Only re-evaluates unsent no_match projects (sent_at IS NULL).
  // Age check applies here too — skips projects older than max age.
  async reEvaluateOldProjects(): Promise<void> {
    logger.info('🔄 Re-evaluating unsent no_match projects...');
    let old: any[] = [];
    try {
      old = Database.getInstance().queryAll(
        `SELECT project_id, title, url, budget, description, skills, created_at
         FROM projects
         WHERE classification = 'no_match'
         AND sent_at IS NULL`
      );
    } catch { logger.warn('Cannot read DB for re-evaluation'); return; }

    logger.info(`Found ${old.length} unsent no_match projects`);
    let matched = 0, notified = 0, skippedOld = 0;

    for (const row of old) {
      const project = {
        project_id: row.project_id, title: row.title, url: row.url,
        budget: row.budget, description: row.description,
        skills: (() => { try { return JSON.parse(row.skills) || []; } catch { return []; } })(),
        // Use created_at from DB as the age reference for re-evaluation
        posted_at: row.created_at as string | undefined,
      };

      const { matched: isMatch, keywords } = this.matcher.matchProject(project);
      if (!isMatch) continue;

      // ── AGE CHECK for re-evaluation ────────────────────────
      const ageCheck = checkProjectAge(
        project.project_id,
        project.title,
        project.posted_at ?? null
      );

      if (!ageCheck.allowed) {
        skippedOld++;
        logger.info(
          `⏭  Re-eval skipped (too old): project_id=${project.project_id}, ` +
          `title="${project.title.slice(0, 60)}", ` +
          `created_at=${project.posted_at}, age=${ageCheck.ageMinutes}min`
        );
        try {
          Database.getInstance().run(
            "UPDATE projects SET classification = 'skipped_old', reason = ? WHERE project_id = ?",
            [ageCheck.reason, project.project_id]
          );
        } catch { /* ignore */ }
        continue;
      }

      matched++;

      // Double-check: skip if somehow already sent
      try {
        const existing = Database.getInstance().queryOne<{ sent_at: string | null }>(
          'SELECT sent_at FROM projects WHERE project_id = ?', [project.project_id]
        );
        if (existing?.sent_at) {
          logger.debug(`Skipping ${project.project_id} — already sent at ${existing.sent_at}`);
          continue;
        }
      } catch { /* proceed */ }

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

    logger.info(`✅ Re-evaluation done — re-matched: ${matched}, notified: ${notified}, skipped_old: ${skippedOld}`);
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
