export interface ScrapedProject {
  project_id: string;
  title: string;
  url: string;
  budget: string;
  description: string;
  skills: string[];
  /** ISO-8601 UTC timestamp (normalised by the scraper), if Mostaql exposed one. */
  posted_at?: string;
}

export interface ProjectRecord {
  id: number;
  project_id: string;
  title: string;
  url: string;
  budget: string;
  description: string;
  skills: string;
  classification: string;
  reason: string;
  matched_keywords: string;
  posted_at: string | null;
  notify_status: NotifyStatus | null;
  notify_attempts: number;
  last_notify_error: string | null;
  created_at: string;
  sent_at: string | null;
}

/** Per-project Telegram delivery state. */
export type NotifyStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export interface ProjectFilter {
  search?: string;
  classification?: string;
  page?: number;
  limit?: number;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ── Scraper result model ─────────────────────────────────────────
export type ScrapeStatus =
  | 'SCRAPE_SUCCESS'       // ≥1 project parsed
  | 'SCRAPE_EMPTY'         // page fetched and recognised, genuinely 0 projects
  | 'SCRAPE_FAILED'        // network error, timeout, 5xx, unexpected response
  | 'SCRAPE_BLOCKED'       // 401/403/429/challenge page — Mostaql refused us
  | 'SCRAPE_PARSE_FAILED'; // 200 HTML but project rows could not be parsed

export type ScrapeTransport = 'direct' | 'relay' | 'proxy' | 'playwright';

export interface ScrapeAttempt {
  transport: ScrapeTransport;
  status: ScrapeStatus;
  http_status?: number;
  duration_ms: number;
  bytes?: number;
  rows_found?: number;
  page_title?: string;
  error?: string;
}

export interface ScrapeResult {
  status: ScrapeStatus;
  projects: ScrapedProject[];
  transport?: ScrapeTransport;
  attempts: ScrapeAttempt[];
  error?: string;
  /** Set when no transport was attempted because direct is cooling down after a block. */
  cooldown_until?: string;
}

// ── Monitoring run result model ─────────────────────────────────
export type RunStatus =
  | 'SUCCESS'                  // scrape OK, every required notification delivered
  | 'SCRAPE_EMPTY'
  | 'SCRAPE_FAILED'
  | 'SCRAPE_BLOCKED'
  | 'SCRAPE_PARSE_FAILED'
  | 'TELEGRAM_FAILED'          // scrape OK, ≥1 notification failed (will be retried)
  | 'SKIPPED_ALREADY_RUNNING'  // another run holds the lock
  | 'SKIPPED_COOLDOWN'         // backing off after Mostaql blocked us
  | 'PAUSED'                   // monitoring_active = false
  | 'ERROR';                   // unexpected internal error

export interface RunResult {
  success: boolean;
  status: RunStatus;
  triggered_by: string;
  scanned: number;
  newCount: number;
  matched: number;
  notified: number;
  notifyFailed: number;
  retried: number;
  skippedOld: number;
  duration_ms: number;
  scrape?: {
    status: ScrapeStatus;
    transport?: ScrapeTransport;
    attempts: ScrapeAttempt[];
  };
  error?: string;
  message?: string;
}
