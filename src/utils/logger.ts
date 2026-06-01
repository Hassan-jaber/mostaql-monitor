import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';

const logDir = process.env.LOG_DIR || './logs';
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const fmt = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const m = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `[${timestamp}] ${level.toUpperCase().padEnd(5)}: ${message}${m}`;
  })
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports: [
    new winston.transports.Console({ format: fmt }),
    new DailyRotateFile({
      filename: path.join(logDir, 'app-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxFiles: '14d',
      format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    }),
    new DailyRotateFile({
      filename: path.join(logDir, 'error-%DATE%.log'),
      level: 'error',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '30d',
      format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    }),
  ],
});

// Kept for backward compat — logs to DB via the Database singleton
export function logToDb(
  level: string, category: string, message: string, metadata?: Record<string, unknown>
): void {
  try {
    const { Database } = require('../database/Database');
    Database.getInstance().run(
      `INSERT INTO system_logs (level, category, message, metadata) VALUES (?, ?, ?, ?)`,
      [level, category, message, metadata ? JSON.stringify(metadata) : null]
    );
  } catch { /* ignore */ }
}
