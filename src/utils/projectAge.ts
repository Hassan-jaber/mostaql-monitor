import { logger } from './logger';

// ──────────────────────────────────────────────────────────────
// Project age checker
//
// Uses NOTIFICATION_MAX_AGE_MINUTES env var (default: 30).
// Called before every Telegram send to skip old projects.
// ──────────────────────────────────────────────────────────────

export function getMaxAgeMinutes(): number {
  const raw = process.env.NOTIFICATION_MAX_AGE_MINUTES;
  const parsed = raw ? parseInt(raw, 10) : 30;
  return isNaN(parsed) || parsed <= 0 ? 30 : parsed;
}

export interface AgeCheckResult {
  allowed: boolean;      // true = send notification
  ageMinutes: number;    // how old the project is
  maxMinutes: number;    // configured threshold
  reason: string;
}

/**
 * Returns whether a project is fresh enough to notify.
 *
 * @param posted_at - ISO 8601 string from <time datetime="..."> in Mostaql HTML,
 *                    OR created_at from DB (for re-evaluation).
 *                    If null/undefined, the project is treated as FRESH
 *                    (we don't penalise projects whose timestamp wasn't scraped).
 */
export function checkProjectAge(
  project_id: string,
  title: string,
  posted_at: string | null | undefined
): AgeCheckResult {
  const maxMinutes = getMaxAgeMinutes();

  // No timestamp available — allow (fail open)
  if (!posted_at) {
    return {
      allowed: true,
      ageMinutes: 0,
      maxMinutes,
      reason: 'No timestamp available — allowing by default',
    };
  }

  const postedDate = new Date(posted_at);
  if (isNaN(postedDate.getTime())) {
    logger.warn(`Invalid timestamp for project ${project_id}: "${posted_at}" — allowing by default`);
    return {
      allowed: true,
      ageMinutes: 0,
      maxMinutes,
      reason: `Invalid timestamp "${posted_at}" — allowing by default`,
    };
  }

  const ageMs = Date.now() - postedDate.getTime();
  const ageMinutes = Math.round(ageMs / 60000);

  if (ageMinutes > maxMinutes) {
    const msg = `Skipped project because age exceeds ${maxMinutes} minutes — ` +
      `project_id=${project_id}, title="${title.slice(0, 60)}", ` +
      `posted_at=${posted_at}, age=${ageMinutes}min`;
    logger.info(`⏭  ${msg}`);
    return {
      allowed: false,
      ageMinutes,
      maxMinutes,
      reason: msg,
    };
  }

  return {
    allowed: true,
    ageMinutes,
    maxMinutes,
    reason: `Project is ${ageMinutes} minutes old — within ${maxMinutes} minute limit`,
  };
}
