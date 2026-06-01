import { Router } from 'express';
import { ProjectRepository } from '../repositories/ProjectRepository';

export const statsRouter = Router();
const repo = new ProjectRepository();

statsRouter.get('/', (_req, res, next) => {
  try {
    const stats = repo.getStats();
    const daily = repo.getDailyCount(30);
    const scoreDistribution = repo.getScoreDistribution();
    res.json({ ...stats, daily, scoreDistribution });
  } catch (e) { next(e); }
});
