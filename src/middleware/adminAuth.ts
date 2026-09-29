import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { AppConfig } from '../config/AppConfig';

// ──────────────────────────────────────────────────────────────
// Optional protection for state-changing endpoints.
//
// If ADMIN_TOKEN is empty the endpoints stay open (backwards
// compatible with the current cron-job.org setup). When it is set,
// callers must send ONE of:
//   Authorization: Bearer <ADMIN_TOKEN>
//   X-Admin-Token: <ADMIN_TOKEN>
//   ?token=<ADMIN_TOKEN>
// ──────────────────────────────────────────────────────────────
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const expected = AppConfig.adminToken;
  if (!expected) return next();

  const auth = String(req.headers.authorization || '');
  const supplied =
    (auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '') ||
    String(req.headers['x-admin-token'] || '') ||
    String((req.query as Record<string, unknown>).token || '');

  if (supplied && safeEqual(supplied, expected)) return next();
  res.status(401).json({ success: false, status: 'UNAUTHORIZED', error: 'Missing or invalid admin token' });
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
