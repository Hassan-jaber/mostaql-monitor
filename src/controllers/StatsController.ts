import { Router } from 'express';
import { ProjectRepository } from '../repositories/ProjectRepository';

export const statsRouter = Router();
const repo = new ProjectRepository();

statsRouter.get('/', (_req, res, next) => {
  try {
    res.json({ ...repo.getStats(), daily: repo.getDailyCount(30), scoreDistribution: repo.getScoreDistribution() });
  } catch (e) { next(e); }
});
