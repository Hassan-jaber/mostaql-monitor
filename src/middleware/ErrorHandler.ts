import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { errorMessage } from '../utils/redact';

export function errorHandler(error: Error, req: Request, res: Response, _next: NextFunction): void {
  const msg = errorMessage(error);
  logger.error(`API error on ${req.method} ${req.path}: ${msg}`);
  res.status(500).json({ success: false, status: 'ERROR', error: 'Internal server error', message: msg });
}
