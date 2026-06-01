import path from 'path';
import fs from 'fs';
import { AppConfig } from '../config/AppConfig';
import { logger } from '../utils/logger';

// We use better-sqlite3 if available, fall back to a file-based JSON store
// so the app always starts. On Windows without build tools, we use a pure-JS SQLite.
let BetterSqlite: any;
try {
  BetterSqlite = require('better-sqlite3');
} catch {
  BetterSqlite = null;
}

// ──────────────────────────────────────────────────────────────
// Tiny JSON-based fallback (no native modules needed)
// ──────────────────────────────────────────────────────────────
class JsonStore {
  private data: Record<string, any[]> = {
    projects: [], notifications: [], settings: [], system_logs: []
  };
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath.replace('.db', '.json');
    this.load();
  }

  private load() {
    try {
      if (fs.existsSync(this.filePath)) {
        this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      }
    } catch { /* start fresh */ }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  table(name: string): any[] {
    if (!this.data[name]) this.data[name] = [];
    return this.data[name];
  }

  nextId(name: string): number {
    const t = this.table(name);
    return t.length === 0 ? 1 : Math.max(...t.map((r: any) => r.id || 0)) + 1;
  }
}

// ──────────────────────────────────────────────────────────────
// Unified Database wrapper
// ──────────────────────────────────────────────────────────────
export class Database {
  private static instance: Database;
  private sqliteDb: any = null;
  private jsonStore: JsonStore | null = null;
  private useSqlite = false;

  private constructor() {}

  static getInstance(): Database {
    if (!Database.instance) Database.instance = new Database();
    return Database.instance;
  }

  async initialize(): Promise<void> {
    const dbPath = path.resolve(AppConfig.dbPath);
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

    if (BetterSqlite) {
      try {
        this.sqliteDb = new BetterSqlite(dbPath);
        this.sqliteDb.pragma('journal_mode = WAL');
        this.sqliteDb.pragma('foreign_keys = ON');
        this.createSqliteTables();
        this.seedDefaultSettings();
        this.useSqlite = true;
        logger.info(`SQLite database initialized at ${dbPath}`);
        return;
      } catch (e) {
        logger.warn('better-sqlite3 failed, falling back to JSON store: ' + (e as Error).message);
      }
    }

    // Fallback to JSON store
    this.jsonStore = new JsonStore(dbPath);
    this.seedJsonSettings();
    logger.info(`JSON store initialized at ${dbPath.replace('.db', '.json')}`);
  }

  // ── Public query API (works for both backends) ─────────────

  run(sql: string, params: any[] = []): void {
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
    if (this.useSqlite) {
      return this.sqliteDb.prepare(sql).all(...params) as T[];
    }
    return this.jsonQuery<T>(sql, params);
  }

  // Keep legacy getDb() for any leftover callers — returns a shim
  getDb(): any {
    if (this.useSqlite) return this.sqliteDb;
    // Return a shim that delegates to our methods
    const self = this;
    return {
      prepare: (sql: string) => ({
        run: (...params: any[]) => self.run(sql, params),
        get: (...params: any[]) => self.queryOne(sql, params),
        all: (...params: any[]) => self.queryAll(sql, params),
      }),
    };
  }

  close(): void {
    if (this.useSqlite && this.sqliteDb) this.sqliteDb.close();
    if (this.jsonStore) this.jsonStore.save();
  }

  // ── SQLite implementation ──────────────────────────────────

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
      CREATE INDEX IF NOT EXISTS idx_projects_created_at ON projects(created_at);
      CREATE INDEX IF NOT EXISTS idx_projects_classification ON projects(classification);
    `);
  }

  private seedDefaultSettings(): void {
    const defaults = [
      ['telegram_bot_token', AppConfig.telegram.botToken || ''],
      ['telegram_chat_id', AppConfig.telegram.chatId || ''],
      ['check_interval', AppConfig.monitoring.checkIntervalSeconds.toString()],
      ['min_score', '0'],
      ['monitoring_active', 'true'],
    ];
    const stmt = this.sqliteDb.prepare(
      `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`
    );
    for (const [k, v] of defaults) stmt.run(k, v);
  }

  // ── JSON fallback implementation ───────────────────────────

  private seedJsonSettings(): void {
    const store = this.jsonStore!;
    const settings = store.table('settings');
    const defaults = [
      ['telegram_bot_token', AppConfig.telegram.botToken || ''],
      ['telegram_chat_id', AppConfig.telegram.chatId || ''],
      ['check_interval', AppConfig.monitoring.checkIntervalSeconds.toString()],
      ['min_score', '0'],
      ['monitoring_active', 'true'],
    ];
    for (const [key, value] of defaults) {
      if (!settings.find((r: any) => r.key === key)) {
        settings.push({ key, value, updated_at: new Date().toISOString() });
      }
    }
    store.save();
  }

  private jsonRun(sql: string, params: any[]): void {
    const store = this.jsonStore!;
    const s = sql.trim().toUpperCase();

    if (s.startsWith('INSERT OR IGNORE INTO PROJECTS')) {
      const t = store.table('projects');
      const pid = params[0];
      if (t.find((r: any) => r.project_id === pid)) return;
      t.push({
        id: store.nextId('projects'),
        project_id: params[0], title: params[1], url: params[2],
        budget: params[3], description: params[4], skills: params[5],
        classification: params[6] || 'matched', reason: params[7] || '',
        matched_keywords: params[8] || '[]',
        created_at: new Date().toISOString(), sent_at: null,
      });
    } else if (s.startsWith('INSERT OR IGNORE INTO SETTINGS') || s.startsWith('INSERT OR REPLACE INTO SETTINGS')) {
      const t = store.table('settings');
      const key = params[0];
      const idx = t.findIndex((r: any) => r.key === key);
      const rec = { key, value: params[1], updated_at: new Date().toISOString() };
      if (idx >= 0) t[idx] = rec; else t.push(rec);
    } else if (s.startsWith('INSERT INTO NOTIFICATIONS')) {
      const t = store.table('notifications');
      t.push({
        id: store.nextId('notifications'),
        project_id: params[0], telegram_status: params[1],
        error_message: params[2] || null, sent_at: new Date().toISOString(),
      });
    } else if (s.startsWith('UPDATE PROJECTS SET CLASSIFICATION')) {
      const t = store.table('projects');
      const projectId = params[params.length - 1]; // last param is project_id
      const row = t.find((r: any) => r.project_id === projectId);
      if (row) {
        row.classification = params[0];
        row.reason = params[1];
        row.matched_keywords = params[2];
      }
    } else if (s.startsWith('UPDATE PROJECTS SET SENT_AT')) {
      const t = store.table('projects');
      const row = t.find((r: any) => r.project_id === params[0]);
      if (row) row.sent_at = new Date().toISOString();
    } else if (s.startsWith('INSERT INTO SYSTEM_LOGS')) {
      const t = store.table('system_logs');
      t.push({
        id: store.nextId('system_logs'),
        level: params[0], category: params[1], message: params[2],
        metadata: params[3] || null, created_at: new Date().toISOString(),
      });
      // Keep only last 1000 logs
      if (t.length > 1000) t.splice(0, t.length - 1000);
    }

    store.save();
  }

  private jsonQuery<T>(sql: string, params: any[]): T[] {
    const store = this.jsonStore!;
    const s = sql.trim().toUpperCase();

    if (s.includes('FROM PROJECTS WHERE PROJECT_ID = ?')) {
      return store.table('projects').filter((r: any) => r.project_id === params[0]) as T[];
    }
    if (s.includes('FROM PROJECTS') && s.includes('SELECT ID')) {
      return store.table('projects').filter((r: any) => r.project_id === params[0]) as T[];
    }
    if (s.includes('FROM SETTINGS WHERE KEY = ?') || s.includes("WHERE KEY = ?")) {
      return store.table('settings').filter((r: any) => r.key === params[0]) as T[];
    }
    if (s.includes('FROM SETTINGS')) {
      return store.table('settings') as T[];
    }
    if (s.includes('FROM PROJECTS') && s.includes('COUNT(*)')) {
      return [{ 'COUNT(*)': store.table('projects').length }] as T[];
    }
    if (s.includes('FROM PROJECTS')) {
      let rows = [...store.table('projects')];
      // Apply simple filters
      if (params.length > 0 && s.includes('WHERE')) {
        // search filter
        if (s.includes('LIKE')) {
          const term = (params[0] as string).replace(/%/g, '').toLowerCase();
          rows = rows.filter((r: any) =>
            r.title?.toLowerCase().includes(term) || r.description?.toLowerCase().includes(term)
          );
        }
        // classification filter
        if (s.includes('CLASSIFICATION = ?')) {
          const cls = params.find((_: any, i: number) => {
            return ['matched', 'no_match'].includes(params[i]);
          });
          if (cls) rows = rows.filter((r: any) => r.classification === cls);
        }
      }
      rows.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      // Apply LIMIT/OFFSET
      const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
      const offsetMatch = sql.match(/OFFSET\s+(\d+)/i);
      const lim = limitMatch ? parseInt(limitMatch[1]) : rows.length;
      const off = offsetMatch ? parseInt(offsetMatch[1]) : 0;
      return rows.slice(off, off + lim) as T[];
    }
    if (s.includes('FROM SYSTEM_LOGS')) {
      let rows = [...store.table('system_logs')];
      rows.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
      const offsetMatch = sql.match(/OFFSET\s+(\d+)/i);
      const lim = limitMatch ? parseInt(limitMatch[1]) : rows.length;
      const off = offsetMatch ? parseInt(offsetMatch[1]) : 0;
      return rows.slice(off, off + lim) as T[];
    }
    if (s.includes('FROM NOTIFICATIONS')) {
      return store.table('notifications') as T[];
    }

    return [];
  }
}
