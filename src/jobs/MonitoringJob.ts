import { MostaqlScraperService } from '../services/MostaqlScraperService';
import { KeywordMatcherService } from '../services/KeywordMatcherService';
import { TelegramService } from '../services/TelegramService';
import { ProjectRepository } from '../repositories/ProjectRepository';
import { Database } from '../database/Database';
import { logger } from '../utils/logger';

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

    // Run first check immediately
    await this.runCheck();

    const ms = interval * 1000;
    this.timer = setInterval(async () => {
      if (this.isRunning) {
        logger.debug('⏭  Skipping — previous check still running');
        return;
      }
      await this.runCheck();
    }, ms);

    // DO NOT call timer.unref() — process must stay alive on Hostinger
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
      // Check if monitoring is paused
      let isActive = true;
      try {
        const row = Database.getInstance().queryOne<{ value: string }>(
          "SELECT value FROM settings WHERE key = 'monitoring_active'"
        );
        isActive = row?.value !== 'false';
      } catch { /* DB unavailable — keep running */ }

      if (!isActive) {
        logger.debug('⏸  Monitoring paused');
        return;
      }

      logger.info('🔍 Checking Mostaql for new projects...');

      const projects = await this.scraper.fetchLatestProjects();

      if (projects.length === 0) {
        logger.warn('⚠️  0 projects returned — Mostaql may be blocking scraping');
        return;
      }

      let newCount = 0;
      let matchedCount = 0;
      let notifiedCount = 0;

      for (const project of projects) {
        // Skip already in DB
        let alreadyExists = false;
        try { alreadyExists = this.repo.exists(project.project_id); } catch { /* DB error */ }
        if (alreadyExists) continue;
        newCount++;

        // Keyword match (title only)
        const { matched, keywords } = this.matcher.matchProject(project);

        if (!matched) {
          try {
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
          } catch { /* ignore DB write failure */ }
          continue;
        }

        matchedCount++;

        // Save to DB
        try {
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
        } catch { /* ignore */ }

        // Send Telegram notification — this is the critical step
        const sent = await this.telegram.sendMatchNotification(project, keywords);
        if (sent) notifiedCount++;

        try {
          Database.getInstance().run(
            'INSERT INTO system_logs (level, category, message, metadata) VALUES (?, ?, ?, ?)',
            ['info', 'matching', `Matched: ${project.title}`, JSON.stringify({ keywords, sent })]
          );
        } catch { /* ignore */ }
      }

      logger.info(`📊 Check done — scanned: ${projects.length}, new: ${newCount}, matched: ${matchedCount}, notified: ${notifiedCount}`);

    } catch (err: any) {
      logger.error('❌ MonitoringJob error: ' + err.message);
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

    logger.info(`Found ${old.length} no_match projects to re-evaluate`);
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
      logger.info(`🔄 Re-matched: "${project.title}" → [${keywords.join(', ')}]`);

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
