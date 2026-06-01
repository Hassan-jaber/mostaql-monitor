import { Database } from '../database/Database';
import { ProjectRecord, ProjectFilter, PaginatedResult } from '../modules/types';

export class ProjectRepository {
  private get db() { return Database.getInstance(); }

  exists(projectId: string): boolean {
    const row = this.db.queryOne(
      'SELECT id FROM projects WHERE project_id = ?',
      [projectId]
    );
    return !!row;
  }

  save(data: {
    project_id: string; title: string; url: string; budget: string;
    description: string; skills: string; classification: string;
    reason: string; matched_keywords: string;
  }): void {
    this.db.run(`
      INSERT OR IGNORE INTO projects
        (project_id, title, url, budget, description, skills, classification, reason, matched_keywords)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      data.project_id, data.title, data.url, data.budget,
      data.description, data.skills, data.classification,
      data.reason, data.matched_keywords,
    ]);
  }

  findById(projectId: string): ProjectRecord | null {
    return this.db.queryOne<ProjectRecord>(
      'SELECT * FROM projects WHERE project_id = ?',
      [projectId]
    );
  }

  findAll(filter: ProjectFilter = {}): PaginatedResult<ProjectRecord> {
    const { search = '', classification, page = 1, limit = 20 } = filter;

    const conds: string[] = [];
    const params: any[] = [];

    if (search) {
      conds.push('(title LIKE ? OR description LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    if (classification) { conds.push('classification = ?'); params.push(classification); }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const countRow = this.db.queryOne<any>(
      `SELECT COUNT(*) as cnt FROM projects ${where}`, params
    );
    const total = Number(countRow?.cnt ?? countRow?.['COUNT(*)'] ?? 0);

    const data = this.db.queryAll<ProjectRecord>(
      `SELECT * FROM projects ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  getStats() {
    const totalRow = this.db.queryOne<any>('SELECT COUNT(*) as cnt FROM projects');
    const total = Number(totalRow?.cnt ?? totalRow?.['COUNT(*)'] ?? 0);

    const todayRow = this.db.queryOne<any>(
      "SELECT COUNT(*) as cnt FROM projects WHERE date(created_at) = date('now')"
    );
    const today = Number(todayRow?.cnt ?? todayRow?.['COUNT(*)'] ?? 0);

    const sentRow = this.db.queryOne<any>(
      'SELECT COUNT(*) as cnt FROM projects WHERE sent_at IS NOT NULL'
    );
    const sent = Number(sentRow?.cnt ?? sentRow?.['COUNT(*)'] ?? 0);

    const clsRows = this.db.queryAll<{ classification: string; count: number }>(
      'SELECT classification, COUNT(*) as count FROM projects GROUP BY classification'
    );
    const byClassification: Record<string, number> = {};
    for (const r of clsRows) byClassification[r.classification] = Number(r.count);

    return { total, today, sent, avgScore: 0, byClassification };
  }

  getDailyCount(days = 14): Array<{ date: string; count: number }> {
    return this.db.queryAll<{ date: string; count: number }>(
      `SELECT date(created_at) as date, COUNT(*) as count
       FROM projects WHERE created_at >= date('now', ?)
       GROUP BY date(created_at) ORDER BY date ASC`,
      [`-${days} days`]
    );
  }

  getScoreDistribution(): Array<{ range: string; count: number }> {
    // Without AI scores, return a simple matched/unmatched breakdown
    const matched = this.db.queryOne<any>(
      "SELECT COUNT(*) as cnt FROM projects WHERE classification = 'matched'"
    );
    const unmatched = this.db.queryOne<any>(
      "SELECT COUNT(*) as cnt FROM projects WHERE classification = 'no_match'"
    );
    return [
      { range: 'matched', count: Number(matched?.cnt ?? matched?.['COUNT(*)'] ?? 0) },
      { range: 'no_match', count: Number(unmatched?.cnt ?? unmatched?.['COUNT(*)'] ?? 0) },
    ];
  }
}
