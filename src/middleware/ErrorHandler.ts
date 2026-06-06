import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

export function errorHandler(error: Error, _req: Request, res: Response, _next: NextFunction): void {
  logger.error('API error: ' + error.message);
  res.status(500).json({ error: 'Internal server error', message: error.message });
}
