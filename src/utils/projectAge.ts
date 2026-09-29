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

/**
 * Parse a timestamp as UTC.
 *
 * Mostaql renders `<time datetime="2026-09-29 09:40:06">` in UTC without a
 * zone designator. `new Date("2026-09-29 09:40:06")` would interpret that in
 * the SERVER's local timezone, so a host not running in UTC would compute a
 * wrong age. SQLite `datetime('now')` values have the same shape.
 */
export function parseUtc(value: string | null | undefined): Date | null {
  if (!value) return null;
  const v = value.trim();
  const naive = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/.exec(v);
  const d = naive ? new Date(`${naive[1]}T${naive[2]}Z`) : new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

export interface AgeCheckResult {
  allowed: boolean;      // true = send notification
  ageMinutes: number;    // how old the project is
  maxMinutes: number;    // configured threshold
  reason: string;
}

/**
 * Returns whether a project is fresh enough to notify.
 * If the timestamp is missing/invalid the project is treated as FRESH.
 */
export function checkProjectAge(
  project_id: string,
  title: string,
  posted_at: string | null | undefined
): AgeCheckResult {
  const maxMinutes = getMaxAgeMinutes();

  if (!posted_at) {
    return { allowed: true, ageMinutes: 0, maxMinutes, reason: 'No timestamp available — allowing by default' };
  }

  const postedDate = parseUtc(posted_at);
  if (!postedDate) {
    logger.warn(`Invalid timestamp for project ${project_id}: "${posted_at}" — allowing by default`);
    return { allowed: true, ageMinutes: 0, maxMinutes, reason: `Invalid timestamp "${posted_at}" — allowing by default` };
  }

  const ageMinutes = Math.max(0, Math.round((Date.now() - postedDate.getTime()) / 60000));

  if (ageMinutes > maxMinutes) {
    const msg = `Skipped project because age exceeds ${maxMinutes} minutes — ` +
      `project_id=${project_id}, title="${title.slice(0, 60)}", ` +
      `posted_at=${posted_at}, age=${ageMinutes}min`;
    logger.info(`⏭  ${msg}`);
    return { allowed: false, ageMinutes, maxMinutes, reason: msg };
  }

  return {
    allowed: true,
    ageMinutes,
    maxMinutes,
    reason: `Project is ${ageMinutes} minutes old — within ${maxMinutes} minute limit`,
  };
}
