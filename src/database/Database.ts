import path from 'path';
import fs from 'fs';
import { AppConfig } from '../config/AppConfig';
import { logger } from '../utils/logger';
import { NotifyStatus } from '../modules/types';

// ──────────────────────────────────────────────────────────────
// Database — dual backend
// 1. better-sqlite3 (native, fast, safe across processes)
// 2. JSON file store fallback (zero native deps, single process)
//
// Monitoring-critical operations (dedupe, notification state,
// run lock, key/value state) are implemented natively for BOTH
// backends. The small SQL emulator for the JSON store is kept only
// for the read-only dashboard endpoints.
// ──────────────────────────────────────────────────────────────

let BetterSqlite: any = null;
let betterSqliteLoadError = '';
try { BetterSqlite = require('better-sqlite3'); } catch (e: any) { betterSqliteLoadError = e?.message || String(e); }

export interface NewProjectRow {
  project_id: string;
  title: string;
  url: string;
  budget: string;
  description: string;
  skills: string;
  classification: string;
  reason: string;
  matched_keywords: string;
  posted_at: string | null;
  notify_status: NotifyStatus | null;
}

export interface RetryableProject {
  project_id: string;
  title: string;
  url: string;
  budget: string;
  description: string;
  skills: string;
  matched_keywords: string;
  posted_at: string | null;
  notify_attempts: number;
  created_at: string;
}

const PROJECT_RETENTION_DAYS = Math.max(7, parseInt(process.env.PROJECT_RETENTION_DAYS || '90', 10) || 90);
const SECRET_SETTING_KEYS = ['telegram_bot_token', 'telegram_chat_id'];

// ── JSON fallback store ────────────────────────────────────────
class JsonStore {
  private data: Record<string, any[]> = {
    projects: [], notifications: [], settings: [], system_logs: [],
  };
  readonly filePath: string;
  private saveTimer: NodeJS.Timeout | null = null;
  lastSaveError = '';

  constructor(dbPath: string) {
    this.filePath = dbPath.replace(/\.db$/, '') + '.json';
    this.load();
  }

  private load() {
    if (!fs.existsSync(this.filePath)) return;
    const raw = fs.readFileSync(this.filePath, 'utf8');
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
      this.data = { projects: [], notifications: [], settings: [], system_logs: [], ...parsed };
    } catch (e: any) {
      // Never silently start fresh over a corrupt file — keep it for inspection.
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      try { fs.renameSync(this.filePath, backup); } catch { /* ignore */ }
      logger.error(`JSON store corrupt (${e.message}) — moved to ${backup}, starting with empty state`);
    }
  }

  /** Write synchronously and atomically (tmp file + rename). */
  flush() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    const tmp = `${this.filePath}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.filePath);
      this.lastSaveError = '';
    } catch (e: any) {
      this.lastSaveError = e.message;
      logger.error(`JSON store write failed: ${e.message}`);
    }
  }

  /** Coalesce many writes within one run into a single disk write. */
  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, 300);
  }

  table(name: string): any[] {
    if (!this.data[name]) this.data[name] = [];
    return this.data[name];
  }

  nextId(name: string): number {
    const t = this.table(name);
    let max = 0;
    for (const r of t) if ((r.id || 0) > max) max = r.id;
    return max + 1;
  }
}

// ── Unified Database class ─────────────────────────────────────
export class Database {
  private static instance: Database;
  private sqliteDb: any = null;
  private jsonStore: JsonStore | null = null;
  private useSqlite = false;
  private memLocks = new Map<string, { owner: string; expires: number }>();
  initError = '';

  private constructor() {}

  static getInstance(): Database {
    if (!Database.instance) Database.instance = new Database();
    return Database.instance;
  }

  async initialize(): Promise<void> {
    const dbPath = path.resolve(AppConfig.dbPath);
    const dbDir = path.dirname(dbPath);

    try {
      if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    } catch (e: any) {
      logger.warn(`Cannot create data dir ${dbDir}: ${e.message}`);
    }

    if (BetterSqlite) {
      try {
        this.sqliteDb = new BetterSqlite(dbPath);
        this.sqliteDb.pragma('journal_mode = WAL');
        this.sqliteDb.pragma('busy_timeout = 5000');
        this.createSqliteTables();
        this.migrateSqlite();
        this.useSqlite = true;
        this.cleanupSecretsAndOldRows();
        logger.info(`✅ SQLite initialized: ${dbPath}`);
        return;
      } catch (e: any) {
        this.initError = `SQLite failed: ${e.message}`;
        logger.warn(`SQLite failed (${e.message}), falling back to JSON store`);
        this.sqliteDb = null;
      }
    } else {
      logger.warn(`better-sqlite3 not available (${betterSqliteLoadError.split('\n')[0]}) — using JSON store`);
    }

    this.jsonStore = new JsonStore(dbPath);
    this.migrateJson();
    this.cleanupSecretsAndOldRows();
    this.jsonStore.flush();
    logger.info(`✅ JSON store initialized: ${this.jsonStore.filePath}`);
  }

  backend(): 'sqlite' | 'json' | 'none' {
    return this.useSqlite ? 'sqlite' : this.jsonStore ? 'json' : 'none';
  }

  storagePath(): string | null {
    if (this.useSqlite) return path.resolve(AppConfig.dbPath);
    return this.jsonStore?.filePath ?? null;
  }

  // ── Generic SQL API (dashboard/read endpoints) ─────────────

  run(sql: string, params: any[] = []): void {
    this.assertReady();
    if (this.useSqlite) {
      this.sqliteDb.prepare(sql).run(...params);
    } else {
      this.jsonRun(sql, params);
    }
  }

  queryOne<T = any>(sql: string, params: any[] = []): T | null {
    return this.queryAll<T>(sql, params)[0] ?? null;
  }

  queryAll<T = any>(sql: string, params: any[] = []): T[] {
    this.assertReady();
    if (this.useSqlite) {
      return this.sqliteDb.prepare(sql).all(...params) as T[];
    }
    return this.jsonQuery<T>(sql, params);
  }

  // Legacy shim for any code using getDb()
  getDb(): any {
    if (this.useSqlite) return this.sqliteDb;
    const self = this;
    return {
      prepare: (sql: string) => ({
        run: (...params: any[]) => self.run(sql, params),
        get: (...params: any[]) => self.queryOne(sql, params),
        all: (...params: any[]) => self.queryAll(sql, params),
      }),
    };
  }

  isReady(): boolean {
    return this.useSqlite || this.jsonStore !== null;
  }

  /** Persist pending JSON writes immediately (end of each run). */
  flush(): void {
    if (this.jsonStore) this.jsonStore.flush();
  }

  close(): void {
    if (this.useSqlite && this.sqliteDb) this.sqliteDb.close();
    if (this.jsonStore) this.jsonStore.flush();
  }

  private assertReady(): void {
    if (!this.isReady()) throw new Error('Database not initialized');
  }

  // ── Key/value settings ──────────────────────────────────────

  getSetting(key: string): string | null {
    if (!this.isReady()) return null;
    if (this.useSqlite) {
      const row = this.sqliteDb.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return row ? row.value : null;
    }
    const row = this.jsonStore!.table('settings').find((r: any) => r.key === key);
    return row ? row.value : null;
  }

  setSetting(key: string, value: string): void {
    if (!this.isReady()) return;
    if (this.useSqlite) {
      this.sqliteDb.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).run(key, value);
      return;
    }
    const t = this.jsonStore!.table('settings');
    const rec = { key, value, updated_at: new Date().toISOString() };
    const idx = t.findIndex((r: any) => r.key === key);
    if (idx >= 0) t[idx] = rec; else t.push(rec);
    this.jsonStore!.save();
  }

  deleteSetting(key: string): void {
    if (!this.isReady()) return;
    if (this.useSqlite) {
      this.sqliteDb.prepare('DELETE FROM settings WHERE key = ?').run(key);
      return;
    }
    const t = this.jsonStore!.table('settings');
    const idx = t.findIndex((r: any) => r.key === key);
    if (idx >= 0) { t.splice(idx, 1); this.jsonStore!.save(); }
  }

  getAllSettings(): Array<{ key: string; value: string }> {
    if (!this.isReady()) return [];
    if (this.useSqlite) return this.sqliteDb.prepare('SELECT key, value FROM settings').all();
    return this.jsonStore!.table('settings').map((r: any) => ({ key: r.key, value: r.value }));
  }

  // ── Run lock (lease) ────────────────────────────────────────
  // SQLite: atomic across processes (Hostinger may run >1 worker).
  // JSON: in-process only (the JSON store itself is single-process).

  tryAcquireLock(name: string, owner: string, ttlMs: number): boolean {
    const now = Date.now();
    const expires = now + ttlMs;
    if (this.useSqlite) {
      const key = `lock:${name}`;
      const value = `${expires}|${owner}`;
      const info = this.sqliteDb.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
         WHERE CAST(substr(settings.value, 1, instr(settings.value, '|') - 1) AS INTEGER) < ?`
      ).run(key, value, now);
      return info.changes === 1;
    }
    const cur = this.memLocks.get(name);
    if (cur && cur.expires >= now) return false;
    this.memLocks.set(name, { owner, expires });
    return true;
  }

  releaseLock(name: string, owner: string): void {
    if (this.useSqlite) {
      try {
        this.sqliteDb.prepare(`DELETE FROM settings WHERE key = ? AND value LIKE ?`)
          .run(`lock:${name}`, `%|${owner}`);
      } catch { /* expires on its own */ }
      return;
    }
    const cur = this.memLocks.get(name);
    if (cur && cur.owner === owner) this.memLocks.delete(name);
  }

  // ── System logs ─────────────────────────────────────────────

  addLog(level: string, category: string, message: string, meta?: object): void {
    if (!this.isReady()) return;
    const metadata = meta ? JSON.stringify(meta) : null;
    if (this.useSqlite) {
      this.sqliteDb.prepare(
        'INSERT INTO system_logs (level, category, message, metadata) VALUES (?, ?, ?, ?)'
      ).run(level, category, message, metadata);
      return;
    }
    const t = this.jsonStore!.table('system_logs');
    t.push({ id: this.jsonStore!.nextId('system_logs'), level, category, message, metadata, created_at: new Date().toISOString() });
    if (t.length > 500) t.splice(0, t.length - 500);
    this.jsonStore!.save();
  }

  // ── Projects: monitoring-critical operations ───────────────

  projectExists(projectId: string): boolean {
    this.assertReady();
    if (this.useSqlite) {
      return !!this.sqliteDb.prepare('SELECT 1 FROM projects WHERE project_id = ?').get(projectId);
    }
    return this.jsonStore!.table('projects').some((r: any) => r.project_id === projectId);
  }

  /** Returns true if inserted, false if the project already existed. */
  insertProject(p: NewProjectRow): boolean {
    this.assertReady();
    if (this.useSqlite) {
      const info = this.sqliteDb.prepare(
        `INSERT OR IGNORE INTO projects
          (project_id, title, url, budget, description, skills, classification, reason,
           matched_keywords, posted_at, notify_status, notify_attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
      ).run(
        p.project_id, p.title, p.url, p.budget, p.description, p.skills, p.classification,
        p.reason, p.matched_keywords, p.posted_at, p.notify_status
      );
      return info.changes === 1;
    }
    const t = this.jsonStore!.table('projects');
    if (t.some((r: any) => r.project_id === p.project_id)) return false;
    t.push({
      id: this.jsonStore!.nextId('projects'),
      ...p,
      notify_attempts: 0,
      last_notify_error: null,
      created_at: new Date().toISOString(),
      sent_at: null,
    });
    this.jsonStore!.save();
    return true;
  }

  /** Record the outcome of a Telegram delivery attempt. */
  recordNotifyResult(projectId: string, ok: boolean, error?: string): void {
    this.assertReady();
    const err = ok ? null : (error || 'unknown error').slice(0, 500);
    if (this.useSqlite) {
      if (ok) {
        this.sqliteDb.prepare(
          `UPDATE projects SET notify_status = 'sent', sent_at = datetime('now'),
             notify_attempts = COALESCE(notify_attempts, 0) + 1, last_notify_error = NULL
           WHERE project_id = ?`
        ).run(projectId);
      } else {
        this.sqliteDb.prepare(
          `UPDATE projects SET notify_status = 'failed',
             notify_attempts = COALESCE(notify_attempts, 0) + 1, last_notify_error = ?
           WHERE project_id = ?`
        ).run(err, projectId);
      }
      this.sqliteDb.prepare(
        `INSERT INTO notifications (project_id, telegram_status, error_message) VALUES (?, ?, ?)`
      ).run(projectId, ok ? 'sent' : 'failed', err);
      return;
    }
    const row = this.jsonStore!.table('projects').find((r: any) => r.project_id === projectId);
    if (row) {
      row.notify_attempts = (row.notify_attempts || 0) + 1;
      if (ok) { row.notify_status = 'sent'; row.sent_at = new Date().toISOString(); row.last_notify_error = null; }
      else { row.notify_status = 'failed'; row.last_notify_error = err; }
    }
    const n = this.jsonStore!.table('notifications');
    n.push({ id: this.jsonStore!.nextId('notifications'), project_id: projectId, telegram_status: ok ? 'sent' : 'failed', error_message: err, sent_at: new Date().toISOString() });
    if (n.length > 2000) n.splice(0, n.length - 2000);
    this.jsonStore!.save();
  }

  /** Matched projects whose notification is pending/failed and still worth retrying. */
  getRetryableProjects(sinceIso: string, maxAttempts: number, limit = 20): RetryableProject[] {
    this.assertReady();
    if (this.useSqlite) {
      // created_at is SQLite UTC 'YYYY-MM-DD HH:MM:SS'; compare in the same format
      const since = sinceIso.replace('T', ' ').replace(/\.\d+Z$|Z$/, '');
      return this.sqliteDb.prepare(
        `SELECT project_id, title, url, budget, description, skills, matched_keywords,
                posted_at, COALESCE(notify_attempts, 0) AS notify_attempts, created_at
         FROM projects
         WHERE classification = 'matched'
           AND notify_status IN ('pending', 'failed')
           AND COALESCE(notify_attempts, 0) < ?
           AND created_at >= ?
         ORDER BY created_at ASC
         LIMIT ?`
      ).all(maxAttempts, since, limit);
    }
    const since = new Date(sinceIso).getTime();
    return this.jsonStore!.table('projects')
      .filter((r: any) =>
        r.classification === 'matched' &&
        (r.notify_status === 'pending' || r.notify_status === 'failed') &&
        (r.notify_attempts || 0) < maxAttempts &&
        new Date(r.created_at).getTime() >= since)
      .sort((a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      .slice(0, limit)
      .map((r: any) => ({ ...r, notify_attempts: r.notify_attempts || 0 }));
  }

  /** Mark a queued notification as permanently skipped (e.g. gave up). */
  markNotifySkipped(projectId: string, reason: string): void {
    this.assertReady();
    if (this.useSqlite) {
      this.sqliteDb.prepare(
        `UPDATE projects SET notify_status = 'skipped', last_notify_error = ? WHERE project_id = ?`
      ).run(reason.slice(0, 500), projectId);
      return;
    }
    const row = this.jsonStore!.table('projects').find((r: any) => r.project_id === projectId);
    if (row) { row.notify_status = 'skipped'; row.last_notify_error = reason.slice(0, 500); this.jsonStore!.save(); }
  }

  updateProjectClassification(projectId: string, classification: string, reason: string, matchedKeywords: string, notifyStatus: NotifyStatus | null): void {
    this.assertReady();
    if (this.useSqlite) {
      this.sqliteDb.prepare(
        `UPDATE projects SET classification = ?, reason = ?, matched_keywords = ?, notify_status = ? WHERE project_id = ?`
      ).run(classification, reason, matchedKeywords, notifyStatus, projectId);
      return;
    }
    const row = this.jsonStore!.table('projects').find((r: any) => r.project_id === projectId);
    if (row) {
      row.classification = classification; row.reason = reason;
      row.matched_keywords = matchedKeywords; row.notify_status = notifyStatus;
      this.jsonStore!.save();
    }
  }

  notificationCounts(): { pending: number; failed: number; sent: number } {
    if (!this.isReady()) return { pending: 0, failed: 0, sent: 0 };
    if (this.useSqlite) {
      const rows = this.sqliteDb.prepare(
        `SELECT notify_status AS s, COUNT(*) AS c FROM projects WHERE notify_status IS NOT NULL GROUP BY notify_status`
      ).all() as Array<{ s: string; c: number }>;
      const m: Record<string, number> = {};
      for (const r of rows) m[r.s] = Number(r.c);
      return { pending: m.pending || 0, failed: m.failed || 0, sent: m.sent || 0 };
    }
    const out = { pending: 0, failed: 0, sent: 0 };
    for (const r of this.jsonStore!.table('projects')) {
      if (r.notify_status === 'pending') out.pending++;
      else if (r.notify_status === 'failed') out.failed++;
      else if (r.notify_status === 'sent') out.sent++;
    }
    return out;
  }

  // ── Schema & migrations ─────────────────────────────────────

  private createSqliteTables(): void {
    this.sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        budget TEXT,
        description TEXT,
        skills TEXT,
        classification TEXT DEFAULT 'matched',
        reason TEXT,
        matched_keywords TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        sent_at DATETIME
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        telegram_status TEXT DEFAULT 'pending',
        error_message TEXT,
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS system_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        category TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_projects_created ON projects(created_at);
      CREATE INDEX IF NOT EXISTS idx_projects_class ON projects(classification);
      CREATE INDEX IF NOT EXISTS idx_logs_created ON system_logs(created_at);
    `);
  }

  /** Additive, idempotent migration of databases created by v3.1.x. */
  private migrateSqlite(): void {
    const cols = new Set<string>(
      (this.sqliteDb.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>).map(c => c.name)
    );
    const add = (name: string, ddl: string) => {
      if (!cols.has(name)) this.sqliteDb.exec(`ALTER TABLE projects ADD COLUMN ${ddl}`);
    };
    add('posted_at', 'posted_at TEXT');
    add('notify_status', 'notify_status TEXT');
    add('notify_attempts', 'notify_attempts INTEGER DEFAULT 0');
    add('last_notify_error', 'last_notify_error TEXT');
    this.sqliteDb.exec(`CREATE INDEX IF NOT EXISTS idx_projects_notify ON projects(notify_status)`);

    // Legacy rows: sent → 'sent'. Legacy matched-but-unsent rows are left
    // NULL on purpose: they are months old and must not be re-sent now.
    this.sqliteDb.exec(`UPDATE projects SET notify_status = 'sent' WHERE sent_at IS NOT NULL AND notify_status IS NULL`);

    // Keep only one default setting that the job reads
    this.sqliteDb.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('monitoring_active', 'true')`).run();
  }

  private migrateJson(): void {
    const store = this.jsonStore!;
    for (const r of store.table('projects')) {
      if (r.notify_status === undefined) r.notify_status = r.sent_at ? 'sent' : null;
      if (r.notify_attempts === undefined) r.notify_attempts = 0;
      if (r.last_notify_error === undefined) r.last_notify_error = null;
      if (r.posted_at === undefined) r.posted_at = null;
    }
    const settings = store.table('settings');
    if (!settings.find((r: any) => r.key === 'monitoring_active')) {
      settings.push({ key: 'monitoring_active', value: 'true', updated_at: new Date().toISOString() });
    }
  }

  /**
   * v3.1.x copied TELEGRAM_BOT_TOKEN / CHAT_ID into the settings table in
   * plain text. Remove those copies — credentials live only in env vars.
   * Also prune old rows so the store does not grow forever.
   */
  private cleanupSecretsAndOldRows(): void {
    try {
      for (const k of SECRET_SETTING_KEYS) this.deleteSetting(k);
      const cutoff = new Date(Date.now() - PROJECT_RETENTION_DAYS * 86400000);
      if (this.useSqlite) {
        const c = cutoff.toISOString().replace('T', ' ').slice(0, 19);
        this.sqliteDb.prepare(`DELETE FROM projects WHERE created_at < ?`).run(c);
        this.sqliteDb.prepare(`DELETE FROM notifications WHERE sent_at < ?`).run(c);
        this.sqliteDb.prepare(`DELETE FROM system_logs WHERE created_at < datetime('now', '-14 days')`).run();
      } else if (this.jsonStore) {
        const t = this.jsonStore.table('projects');
        const kept = t.filter((r: any) => !r.created_at || new Date(r.created_at) >= cutoff);
        if (kept.length !== t.length) { t.splice(0, t.length, ...kept); }
      }
    } catch (e: any) {
      logger.warn(`Startup cleanup failed: ${e.message}`);
    }
  }

  // ── JSON SQL emulator (dashboard endpoints only) ───────────

  private jsonRun(sql: string, params: any[]): void {
    const store = this.jsonStore!;
    const s = sql.trim().toUpperCase();

    if (s.includes('INTO SETTINGS')) {
      const key = params[0];
      const t = store.table('settings');
      const idx = t.findIndex((r: any) => r.key === key);
      const rec = { key, value: params[1], updated_at: new Date().toISOString() };
      if (idx >= 0) t[idx] = rec; else t.push(rec);
    } else if (s.startsWith('INSERT INTO SYSTEM_LOGS')) {
      this.addLog(params[0], params[1], params[2], params[3] ? safeParse(params[3]) : undefined);
      return;
    } else if (s.startsWith('DELETE FROM SYSTEM_LOGS')) {
      const cutoff = Date.now() - 7 * 86400000;
      const t = store.table('system_logs');
      const kept = t.filter((r: any) => new Date(r.created_at).getTime() >= cutoff);
      t.splice(0, t.length, ...kept);
    } else {
      logger.warn(`JSON store: unsupported write ignored: ${sql.trim().slice(0, 80)}`);
      return;
    }
    store.save();
  }

  private jsonQuery<T>(sql: string, params: any[]): T[] {
    const store = this.jsonStore!;
    const s = sql.trim().toUpperCase();

    if (s.includes('FROM SETTINGS')) {
      if (s.includes('WHERE KEY = ?')) return store.table('settings').filter((r: any) => r.key === params[0]) as T[];
      const lit = /WHERE\s+KEY\s*=\s*'([^']+)'/i.exec(sql);
      if (lit) return store.table('settings').filter((r: any) => r.key === lit[1]) as T[];
      return store.table('settings') as T[];
    }

    if (s.includes('FROM PROJECTS') && s.includes('COUNT(*)') && !s.includes('GROUP BY')) {
      return [{ cnt: store.table('projects').length }] as T[];
    }
    if (s.includes('FROM PROJECTS') && s.includes('GROUP BY CLASSIFICATION')) {
      const m: Record<string, number> = {};
      for (const r of store.table('projects')) m[r.classification] = (m[r.classification] || 0) + 1;
      return Object.entries(m).map(([classification, count]) => ({ classification, count })) as T[];
    }
    if (s.includes('FROM PROJECTS') && s.includes('WHERE PROJECT_ID')) {
      return store.table('projects').filter((r: any) => r.project_id === params[0]) as T[];
    }
    if (s.includes('FROM PROJECTS') && !s.includes('GROUP BY')) {
      const rows = [...store.table('projects')];
      rows.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      // LIMIT ? OFFSET ? are the last two params
      const lim = s.includes('LIMIT ?') ? Number(params[params.length - 2]) : undefined;
      const off = s.includes('OFFSET ?') ? Number(params[params.length - 1]) : 0;
      return rows.slice(off, lim !== undefined ? off + lim : undefined) as T[];
    }
    if (s.includes('FROM SYSTEM_LOGS') && s.includes('COUNT(*)')) {
      return [{ cnt: store.table('system_logs').length }] as T[];
    }
    if (s.includes('FROM SYSTEM_LOGS')) {
      const rows = [...store.table('system_logs')];
      rows.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      const lim = s.includes('LIMIT ?') ? Number(params[params.length - 2]) : undefined;
      const off = s.includes('OFFSET ?') ? Number(params[params.length - 1]) : 0;
      return rows.slice(off, lim !== undefined ? off + lim : undefined) as T[];
    }
    if (s.includes('FROM NOTIFICATIONS')) return store.table('notifications') as T[];
    return [];
  }
}

function safeParse(v: any): any {
  try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return { raw: String(v) }; }
}
