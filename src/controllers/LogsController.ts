import { Router, Request, Response, NextFunction } from 'express';
import { Database } from '../database/Database';

export const logsRouter = Router();

logsRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { category, level, page = '1', limit = '50' } = req.query as Record<string, string>;
    const conds: string[] = [];
    const params: any[] = [];
    if (category) { conds.push('category = ?'); params.push(category); }
    if (level) { conds.push('level = ?'); params.push(level); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const countRow = Database.getInstance().queryOne<any>(`SELECT COUNT(*) as cnt FROM system_logs ${where}`, params);
    const total = Number(countRow?.cnt ?? countRow?.['COUNT(*)'] ?? 0);
    const data = Database.getInstance().queryAll(
      `SELECT * FROM system_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );
    res.json({ data, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (e) { next(e); }
});

logsRouter.delete('/', (_req, res, next) => {
  try {
    Database.getInstance().run(`DELETE FROM system_logs WHERE created_at < datetime('now', '-7 days')`);
    res.json({ success: true });
  } catch (e) { next(e); }
});
