import { Router, Request, Response, NextFunction } from 'express';
import { ProjectRepository } from '../repositories/ProjectRepository';
import { KeywordMatcherService } from '../services/KeywordMatcherService';

export const projectRouter = Router();
const repo = new ProjectRepository();
const matcher = new KeywordMatcherService();

projectRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { search, classification, page = '1', limit = '20' } = req.query as Record<string, string>;
    const result = repo.findAll({
      search, classification,
      page: parseInt(page), limit: parseInt(limit),
    });
    res.json(result);
  } catch (e) { next(e); }
});

projectRouter.get('/stats', (_req, res, next) => {
  try {
    const stats = repo.getStats();
    const daily = repo.getDailyCount();
    const scoreDistribution = repo.getScoreDistribution();
    const allProjects = repo.findAll({ limit: 5000 });
    const keywordStats = matcher.getKeywordStats(
      allProjects.data.map(p => ({ matched_keywords: p.matched_keywords }))
    );
    const topKeywords = Object.entries(keywordStats)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([keyword, count]) => ({ keyword, count }));
    res.json({ ...stats, daily, scoreDistribution, topKeywords });
  } catch (e) { next(e); }
});

projectRouter.get('/:id', (req, res, next) => {
  try {
    const project = repo.findById(req.params.id);
    if (!project) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(project);
  } catch (e) { next(e); }
});
