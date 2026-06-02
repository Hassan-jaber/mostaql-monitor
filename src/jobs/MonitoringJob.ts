import { MostaqlScraperService } from '../services/MostaqlScraperService';
import { KeywordMatcherService } from '../services/KeywordMatcherService';
import { TelegramService } from '../services/TelegramService';
import { ProjectRepository } from '../repositories/ProjectRepository';
import { Database } from '../database/Database';
import { logger } from '../utils/logger';

// ──────────────────────────────────────────────────────────────
// MonitoringJob
//
// Flow: Scrape → Filter new → Keyword match → Save → Notify
// No AI. Notifications fire immediately on keyword match.
//
// DB reset command: if a file "RESET_DB" exists in working dir,
// clears all projects so they get re-evaluated.
// ──────────────────────────────────────────────────────────────
export class MonitoringJob {
  private scraper = new MostaqlScraperService();
  private matcher = new KeywordMatcherService();
  private telegram = new TelegramService();
  private repo = new ProjectRepository();
  private timer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  async start(): Promise<void> {
    const interval = this.getInterval();
    logger.info(`⏱  Monitoring every ${interval}s`);

    // Run immediately
    await this.runCheck();

    const ms = interval * 1000;
    this.timer = setInterval(async () => {
      if (this.isRunning) { logger.debug('⏭  Skipping — previous check still running'); return; }
      await this.runCheck();
    }, ms);

    logger.info('Monitoring timer created');
    logger.info(`Interval = ${interval}s`);
    logger.info(`✅ Monitoring started (interval: ${interval}s)`);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    logger.info('🛑 Monitoring stopped');
  }

  async runCheck(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      // Check pause state
      const active = Database.getInstance().queryOne<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'monitoring_active'"
      );
      if (active?.value === 'false') {
        logger.debug('⏸  Monitoring paused');
        return;
      }

      logger.info('🔍 Checking Mostaql for new projects...');

      const projects = await this.scraper.fetchLatestProjects();
      if (projects.length === 0) {
        logger.warn('⚠️  0 projects returned — scraping may be blocked');
        return;
      }

      let newCount = 0;
      let matchedCount = 0;
      let notifiedCount = 0;

      for (const project of projects) {
        // Skip already processed
        if (this.repo.exists(project.project_id)) continue;
        newCount++;

        // ── Keyword match ─────────────────────────────────────
        const { matched, keywords } = this.matcher.matchProject(project);

        if (!matched) {
          // Save as no_match so we don't recheck
          this.repo.save({
            project_id: project.project_id,
            title: project.title,
            url: project.url,
            budget: project.budget || 'غير محدد',
            description: project.description || '',
            skills: JSON.stringify(project.skills || []),
            classification: 'no_match',
            reason: 'No keywords matched',
            matched_keywords: '[]',
          });
          continue;
        }

        matchedCount++;

        // ── Save to DB ────────────────────────────────────────
        this.repo.save({
          project_id: project.project_id,
          title: project.title,
          url: project.url,
          budget: project.budget || 'غير محدد',
          description: project.description || '',
          skills: JSON.stringify(project.skills || []),
          classification: 'matched',
          reason: `Matched: ${keywords.join(', ')}`,
          matched_keywords: JSON.stringify(keywords),
        });

        // ── Send Telegram notification immediately ────────────
        const sent = await this.telegram.sendMatchNotification(project, keywords);
        if (sent) notifiedCount++;

        // DB log
        this.dbLog('info', 'matching', `Matched: ${project.title}`, { keywords, sent });
      }

      logger.info(
        `📊 Check done — scanned: ${projects.length}, new: ${newCount}, matched: ${matchedCount}, notified: ${notifiedCount}`
      );

    } catch (err: any) {
      logger.error('❌ MonitoringJob error: ' + err.message);
      this.dbLog('error', 'monitoring', err.message);
    } finally {
      this.isRunning = false;
    }
  }

  // ── Re-evaluate all no_match projects (run once after fix) ──
  async reEvaluateOldProjects(): Promise<void> {
    logger.info('🔄 Re-evaluating old no_match projects...');

    const old = Database.getInstance().queryAll<{
      project_id: string; title: string; url: string;
      budget: string; description: string; skills: string;
    }>(
      "SELECT project_id, title, url, budget, description, skills FROM projects WHERE classification = 'no_match'"
    );

    logger.info(`Found ${old.length} no_match projects to re-evaluate`);
    let matched = 0;
    let notified = 0;

    for (const row of old) {
      const project = {
        project_id: row.project_id,
        title: row.title,
        url: row.url,
        budget: row.budget,
        description: row.description,
        skills: this.parseJsonArray(row.skills),
      };

      const { matched: isMatch, keywords } = this.matcher.matchProject(project);
      if (!isMatch) continue;

      matched++;
      logger.info(`🔄 Re-matched: "${project.title}" → [${keywords.join(', ')}]`);

      // Update DB
      Database.getInstance().run(
        "UPDATE projects SET classification = 'matched', reason = ?, matched_keywords = ? WHERE project_id = ?",
        [`Re-matched: ${keywords.join(', ')}`, JSON.stringify(keywords), project.project_id]
      );

      // Send notification
      const sent = await this.telegram.sendMatchNotification(project, keywords);
      if (sent) notified++;
    }

    logger.info(`✅ Re-evaluation done — matched: ${matched}, notified: ${notified}`);
  }

  private parseJsonArray(json: string): string[] {
    try { return JSON.parse(json) || []; } catch { return []; }
  }

  private getInterval(): number {
    const row = Database.getInstance().queryOne<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'check_interval'"
    );
    const val = parseInt(row?.value || '60', 10);
    return isNaN(val) || val < 10 ? 60 : val;
  }

  private dbLog(level: string, category: string, message: string, meta?: object): void {
    try {
      Database.getInstance().run(
        'INSERT INTO system_logs (level, category, message, metadata) VALUES (?, ?, ?, ?)',
        [level, category, message, meta ? JSON.stringify(meta) : null]
      );
    } catch { /* non-critical */ }
  }
}
