import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';
import { redact } from './redact';

const logDir = process.env.LOG_DIR || './logs';
let fileLogging = true;
try {
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
} catch { fileLogging = false; }

// Every log line is scrubbed of secrets before it is written anywhere.
const scrub = winston.format((info) => {
  info.message = redact(info.message);
  return info;
});

const fmt = winston.format.combine(
  scrub(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message }) =>
    `[${timestamp}] ${level.toUpperCase().padEnd(5)}: ${message}`
  )
);

const transports: winston.transport[] = [
  new winston.transports.Console({ format: fmt }),
];

if (fileLogging) {
  try {
    transports.push(
      new DailyRotateFile({
        filename: path.join(logDir, 'app-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        maxFiles: '14d',
        format: winston.format.combine(scrub(), winston.format.timestamp(), winston.format.json()),
      })
    );
  } catch { /* file logging unavailable */ }
}

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports,
});

export function logToDb(level: string, category: string, message: string, meta?: object): void {
  try {
    // Lazy require avoids a circular import (Database imports logger)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Database } = require('../database/Database');
    Database.getInstance().addLog(level, category, redact(message), meta ? JSON.parse(redact(meta)) : undefined);
  } catch { /* non-critical */ }
}
