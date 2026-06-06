import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';

const logDir = process.env.LOG_DIR || './logs';
try {
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
} catch { /* ignore if not writable */ }

const fmt = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message }) =>
    `[${timestamp}] ${level.toUpperCase().padEnd(5)}: ${message}`
  )
);

const transports: winston.transport[] = [
  new winston.transports.Console({ format: fmt }),
];

// Add file transport only if logs dir is writable
try {
  transports.push(
    new DailyRotateFile({
      filename: path.join(logDir, 'app-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxFiles: '7d',
      format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    })
  );
} catch { /* file logging unavailable */ }

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports,
});

export function logToDb(level: string, category: string, message: string, meta?: object): void {
  try {
    const { Database } = require('../database/Database');
    Database.getInstance().run(
      'INSERT INTO system_logs (level, category, message, metadata) VALUES (?, ?, ?, ?)',
      [level, category, message, meta ? JSON.stringify(meta) : null]
    );
  } catch { /* non-critical */ }
}
