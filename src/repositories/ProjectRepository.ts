import { Database, NewProjectRow, RetryableProject } from '../database/Database';
import { ProjectRecord, ProjectFilter, PaginatedResult, NotifyStatus } from '../modules/types';

export class ProjectRepository {
  private get db() { return Database.getInstance(); }

  /** Throws if the database is unavailable — callers must NOT treat that as "new". */
  exists(projectId: string): boolean {
    return this.db.projectExists(projectId);
  }

  /** Returns true if the row was inserted, false if it already existed. */
  save(data: NewProjectRow): boolean {
    return this.db.insertProject(data);
  }

  recordNotifyResult(projectId: string, ok: boolean, error?: string): void {
    this.db.recordNotifyResult(projectId, ok, error);
  }

  markNotifySkipped(projectId: string, reason: string): void {
    this.db.markNotifySkipped(projectId, reason);
  }

  getRetryable(sinceIso: string, maxAttempts: number, limit = 20): RetryableProject[] {
    return this.db.getRetryableProjects(sinceIso, maxAttempts, limit);
  }

  updateClassification(projectId: string, classification: string, reason: string, matchedKeywords: string, notifyStatus: NotifyStatus | null): void {
    this.db.updateProjectClassification(projectId, classification, reason, matchedKeywords, notifyStatus);
  }

  findById(projectId: string): ProjectRecord | null {
    return this.db.queryOne<ProjectRecord>(
      'SELECT * FROM projects WHERE project_id = ?', [projectId]
    );
  }

  findAll(filter: ProjectFilter = {}): PaginatedResult<ProjectRecord> {
    const { search = '', classification, page = 1, limit = 20 } = filter;
    const conds: string[] = [];
    const params: any[] = [];

    if (search) { conds.push('(title LIKE ? OR description LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
    if (classification) { conds.push('classification = ?'); params.push(classification); }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const countRow = this.db.queryOne<any>(`SELECT COUNT(*) as cnt FROM projects ${where}`, params);
    const total = Number(countRow?.cnt ?? countRow?.['COUNT(*)'] ?? 0);
    const data = this.db.queryAll<ProjectRecord>(
      `SELECT * FROM projects ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  getStats() {
    const total = Number(this.db.queryOne<any>('SELECT COUNT(*) as cnt FROM projects')?.cnt ?? 0);
    const today = Number(this.db.queryOne<any>("SELECT COUNT(*) as cnt FROM projects WHERE date(created_at) = date('now')")?.cnt ?? 0);
    const sent = Number(this.db.queryOne<any>('SELECT COUNT(*) as cnt FROM projects WHERE sent_at IS NOT NULL')?.cnt ?? 0);
    const clsRows = this.db.queryAll<{ classification: string; count: number }>(
      'SELECT classification, COUNT(*) as count FROM projects GROUP BY classification'
    );
    const byClassification: Record<string, number> = {};
    for (const r of clsRows) byClassification[r.classification] = Number(r.count);
    return { total, today, sent, avgScore: 0, byClassification };
  }

  getDailyCount(days = 14): Array<{ date: string; count: number }> {
    return this.db.queryAll(
      `SELECT date(created_at) as date, COUNT(*) as count FROM projects WHERE created_at >= date('now', ?) GROUP BY date(created_at) ORDER BY date ASC`,
      [`-${days} days`]
    );
  }

  getScoreDistribution(): Array<{ range: string; count: number }> {
    const rows = this.db.queryAll<{ classification: string; count: number }>(
      'SELECT classification, COUNT(*) as count FROM projects GROUP BY classification'
    );
    const get = (c: string) => Number(rows.find(r => r.classification === c)?.count ?? 0);
    return [{ range: 'matched', count: get('matched') }, { range: 'no_match', count: get('no_match') }];
  }
}
