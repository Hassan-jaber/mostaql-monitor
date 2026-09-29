import fs from 'fs';
import * as cheerio from 'cheerio';
import axios, { AxiosRequestConfig } from 'axios';
import {
  ScrapedProject, ScrapeAttempt, ScrapeResult, ScrapeStatus, ScrapeTransport,
} from '../modules/types';
import { AppConfig } from '../config/AppConfig';
import { Database } from '../database/Database';
import { logger } from '../utils/logger';
import { errorMessage, redact } from '../utils/redact';
import { parseUtc } from '../utils/projectAge';

const BASE_URL = 'https://mostaql.com';

// ──────────────────────────────────────────────────────────────
// Mostaql listing markup (re-verified 2026-09-29 against the raw,
// non-JS server response — 25 rows, no browser needed):
//
//   <tr class="project-row">
//     <h2 class="mrg--bt-reset">
//       <a href="https://mostaql.com/project/1281481-slug">TITLE</a>
//     </h2>
//     <time datetime="2026-09-29 09:40:06">  ← UTC, no zone suffix
//     <p class="text-wrapper-div project__brief">
//       <a class="details-url" href="...">DESCRIPTION</a>
//     </p>
//   </tr>
//
// Transports, tried in order until one returns SUCCESS or EMPTY:
//   1. direct     — plain HTTPS from this server
//   2. relay      — SCRAPER_RELAY_URL (Cloudflare Worker / scraping API)
//   3. proxy      — SCRAPER_PROXY_URL (HTTP(S) proxy)
//   4. playwright — only if PLAYWRIGHT_FALLBACK=true (local machines)
//
// Every failure is classified — nothing is converted into [].
// ──────────────────────────────────────────────────────────────

const CHALLENGE_MARKERS = [
  'cf-chl', 'challenge-platform', 'just a moment', 'attention required',
  'access denied', 'request unsuccessful', '_incapsula_resource', 'ddos-guard',
  'please enable javascript and cookies', 'verify you are human', 'captcha',
];
const EMPTY_MARKERS = ['لا توجد مشاريع', 'لا يوجد مشاريع', 'لم يتم العثور على'];

const COOLDOWN_KEY = 'scraper_direct_blocked_until';

interface ParsedPage {
  projects: ScrapedProject[];
  rowsFound: number;
  pageTitle: string;
}

interface Classified {
  status: ScrapeStatus;
  projects: ScrapedProject[];
  rowsFound?: number;
  pageTitle?: string;
  error?: string;
}

export class MostaqlScraperService {

  async fetchLatestProjects(): Promise<ScrapeResult> {
    const cfg = AppConfig.scraper;
    const attempts: ScrapeAttempt[] = [];

    const transports: ScrapeTransport[] = [];
    const cooldownUntil = this.getDirectCooldown();
    const hasAlternative = !!(cfg.relayUrl || cfg.proxyUrl || cfg.playwrightEnabled);

    if (!cooldownUntil) transports.push('direct');
    if (cfg.relayUrl) transports.push('relay');
    if (cfg.proxyUrl) transports.push('proxy');
    if (cfg.playwrightEnabled) transports.push('playwright');

    if (transports.length === 0) {
      // Only direct is configured and it is cooling down after a block.
      logger.warn(`⏸  Direct scraping paused until ${cooldownUntil} (Mostaql blocked this server). Configure SCRAPER_RELAY_URL or SCRAPER_PROXY_URL.`);
      return {
        status: 'SCRAPE_BLOCKED',
        projects: [],
        attempts,
        cooldown_until: cooldownUntil!,
        error: `Direct access blocked by Mostaql; paused until ${cooldownUntil}`,
      };
    }
    if (cooldownUntil && hasAlternative) {
      logger.info(`↪  Skipping direct transport (blocked, cooling down until ${cooldownUntil})`);
    }

    logger.info(`📡 Fetching projects from Mostaql via [${transports.join(' → ')}]`);

    for (const t of transports) {
      const attempt = await this.runTransport(t);
      attempts.push(attempt.meta);

      if (t === 'direct') {
        if (attempt.meta.status === 'SCRAPE_BLOCKED') this.setDirectCooldown();
        else if (attempt.meta.status === 'SCRAPE_SUCCESS' || attempt.meta.status === 'SCRAPE_EMPTY') this.clearDirectCooldown();
      }

      if (attempt.meta.status === 'SCRAPE_SUCCESS' || attempt.meta.status === 'SCRAPE_EMPTY') {
        logger.info(`✅ ${t}: ${attempt.meta.status} — ${attempt.projects.length} projects (${attempt.meta.duration_ms}ms)`);
        return { status: attempt.meta.status, projects: attempt.projects, transport: t, attempts };
      }
      logger.warn(`❌ ${t}: ${attempt.meta.status}` +
        (attempt.meta.http_status ? ` HTTP ${attempt.meta.http_status}` : '') +
        (attempt.meta.error ? ` — ${attempt.meta.error}` : '') +
        ` (${attempt.meta.duration_ms}ms)`);
    }

    // All transports failed: report the most specific cause.
    const priority: ScrapeStatus[] = ['SCRAPE_PARSE_FAILED', 'SCRAPE_BLOCKED', 'SCRAPE_FAILED'];
    const status = priority.find(p => attempts.some(a => a.status === p)) || 'SCRAPE_FAILED';
    const summary = attempts
      .map(a => `${a.transport}: ${a.status}${a.http_status ? ` HTTP ${a.http_status}` : ''}${a.error ? ` (${a.error})` : ''}`)
      .join('; ');
    return { status, projects: [], attempts, error: summary };
  }

  // ── Transport dispatch ─────────────────────────────────────

  private async runTransport(t: ScrapeTransport): Promise<{ meta: ScrapeAttempt; projects: ScrapedProject[] }> {
    const started = Date.now();
    try {
      switch (t) {
        case 'direct': return await this.viaHttp('direct', AppConfig.scraper.targetUrl, {}, started, 2);
        case 'relay': return await this.viaHttp('relay', this.buildRelayUrl(), this.relayHeaders(), started, 1);
        case 'proxy': return await this.viaHttp('proxy', AppConfig.scraper.targetUrl, await this.proxyConfig(), started, 1);
        case 'playwright': return await this.viaPlaywright(started);
      }
    } catch (e: any) {
      return {
        meta: { transport: t, status: 'SCRAPE_FAILED', duration_ms: Date.now() - started, error: errorMessage(e) },
        projects: [],
      };
    }
  }

  // ── HTTP transports (direct / relay / proxy) ───────────────

  private async viaHttp(
    transport: ScrapeTransport,
    url: string,
    extra: AxiosRequestConfig,
    started: number,
    maxTries: number,
  ): Promise<{ meta: ScrapeAttempt; projects: ScrapedProject[] }> {
    let last: { meta: ScrapeAttempt; projects: ScrapedProject[] } | null = null;

    for (let attempt = 1; attempt <= maxTries; attempt++) {
      try {
        const resp = await axios.get<string>(url, {
          timeout: AppConfig.scraper.timeoutMs,
          responseType: 'text',
          maxRedirects: 5,
          maxContentLength: 10 * 1024 * 1024,
          proxy: false,           // never pick up HTTP(S)_PROXY env implicitly
          decompress: true,
          validateStatus: () => true,
          ...extra,
          headers: { ...this.browserHeaders(), ...(extra.headers as Record<string, string> || {}) },
        });

        const body = typeof resp.data === 'string' ? resp.data : String(resp.data ?? '');
        const ct = String(resp.headers['content-type'] || '');
        const c = this.classify(resp.status, ct, body);

        last = {
          meta: {
            transport, status: c.status, http_status: resp.status,
            duration_ms: Date.now() - started, bytes: body.length,
            rows_found: c.rowsFound, page_title: c.pageTitle, error: c.error,
          },
          projects: c.projects,
        };

        // Retry only transient server errors, never blocks or parse failures.
        const transient = c.status === 'SCRAPE_FAILED' && resp.status >= 500 && resp.status !== 503;
        if (!transient) return last;
      } catch (e: any) {
        const code = e?.code || '';
        const timedOut = code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /timeout/i.test(e?.message || '');
        last = {
          meta: {
            transport, status: 'SCRAPE_FAILED', duration_ms: Date.now() - started,
            error: timedOut ? `timeout after ${AppConfig.scraper.timeoutMs}ms` : errorMessage(e),
          },
          projects: [],
        };
      }
      if (attempt < maxTries) await sleep(2000);
    }
    return last!;
  }

  /** Decide what an HTTP response means. Pure function — unit-testable. */
  classify(httpStatus: number, contentType: string, body: string): Classified {
    const lower = body.slice(0, 20000).toLowerCase();
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
    const pageTitle = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim().slice(0, 120) : undefined;
    const hint = pageTitle
      ? ` "${pageTitle}"`
      : (() => { const t = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100); return t ? ` "${t}"` : ''; })();

    if (httpStatus === 401 || httpStatus === 403 || httpStatus === 429) {
      return { status: 'SCRAPE_BLOCKED', projects: [], pageTitle, error: `HTTP ${httpStatus}${hint}` };
    }
    if (httpStatus === 503 && CHALLENGE_MARKERS.some(m => lower.includes(m))) {
      return { status: 'SCRAPE_BLOCKED', projects: [], pageTitle, error: 'HTTP 503 bot challenge' };
    }
    if (httpStatus !== 200) {
      return { status: 'SCRAPE_FAILED', projects: [], pageTitle, error: `unexpected HTTP ${httpStatus}${hint}` };
    }
    if (!body.trim()) {
      return { status: 'SCRAPE_FAILED', projects: [], error: 'empty response body' };
    }
    const looksHtml = /html/i.test(contentType) || /<html|<!doctype html/i.test(body.slice(0, 2000));
    if (!looksHtml) {
      return { status: 'SCRAPE_FAILED', projects: [], error: `expected HTML, got "${contentType || 'unknown content-type'}"` };
    }

    const parsed = this.parseHTML(body);
    if (parsed.projects.length > 0) {
      if (parsed.rowsFound > parsed.projects.length) {
        logger.warn(`Parser: ${parsed.rowsFound} rows found, only ${parsed.projects.length} parsed`);
      }
      return { status: 'SCRAPE_SUCCESS', projects: parsed.projects, rowsFound: parsed.rowsFound, pageTitle: parsed.pageTitle };
    }
    if (parsed.rowsFound > 0) {
      return {
        status: 'SCRAPE_PARSE_FAILED', projects: [], rowsFound: parsed.rowsFound, pageTitle: parsed.pageTitle,
        error: `${parsed.rowsFound} tr.project-row found but no title/link could be extracted — Mostaql markup changed`,
      };
    }
    if (CHALLENGE_MARKERS.some(m => lower.includes(m))) {
      return { status: 'SCRAPE_BLOCKED', projects: [], rowsFound: 0, pageTitle: parsed.pageTitle, error: `bot challenge page${pageTitle ? ` "${pageTitle}"` : ''}` };
    }
    if (EMPTY_MARKERS.some(m => body.includes(m))) {
      return { status: 'SCRAPE_EMPTY', projects: [], rowsFound: 0, pageTitle: parsed.pageTitle };
    }
    return {
      status: 'SCRAPE_PARSE_FAILED', projects: [], rowsFound: 0, pageTitle: parsed.pageTitle,
      error: `no tr.project-row in ${body.length} bytes${pageTitle ? ` (title "${pageTitle}")` : ''}`,
    };
  }

  // ── HTML parser ────────────────────────────────────────────

  parseHTML(html: string): ParsedPage {
    const $ = cheerio.load(html);
    const projects: ScrapedProject[] = [];
    const seen = new Set<string>();
    const rows = $('tr.project-row');

    rows.each((_, el) => {
      const $row = $(el);

      const $link = $row.find('h2 a[href*="/project/"]').first().length
        ? $row.find('h2 a[href*="/project/"]').first()
        : $row.find('a[href*="/project/"]').not('[href*="/project/create"]').first();
      const title = $link.text().replace(/\s+/g, ' ').trim();
      if (!title || title.length < 3) return;

      const href = $link.attr('href') || '';
      const idMatch = href.match(/\/project\/(\d+)/);
      if (!idMatch) return; // no stable numeric ID → skip rather than invent one

      const url = href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;
      const projectId = idMatch[1];
      if (seen.has(projectId)) return;
      seen.add(projectId);

      const description = (
        $row.find('p.project__brief a.details-url').first().text() ||
        $row.find('.project__brief').first().text() ||
        $row.find('.text-wrapper-div a').first().text()
      ).replace(/\s+/g, ' ').trim().slice(0, 600);

      const rawTime = $row.find('time[datetime]').attr('datetime');
      const posted = parseUtc(rawTime);

      projects.push({
        project_id: projectId,
        title,
        url,
        budget: 'غير محدد',
        description,
        skills: [],
        posted_at: posted ? posted.toISOString() : undefined,
      });
    });

    return { projects, rowsFound: rows.length, pageTitle: $('title').first().text().replace(/\s+/g, ' ').trim().slice(0, 120) };
  }

  // ── Playwright (opt-in, local only) ────────────────────────

  private async viaPlaywright(started: number): Promise<{ meta: ScrapeAttempt; projects: ScrapedProject[] }> {
    const fail = (status: ScrapeStatus, error: string, http?: number) => ({
      meta: { transport: 'playwright' as const, status, http_status: http, duration_ms: Date.now() - started, error },
      projects: [] as ScrapedProject[],
    });

    let chromium: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      chromium = require('playwright').chromium;
    } catch {
      return fail('SCRAPE_FAILED', 'playwright package not installed');
    }

    let exe = '';
    try { exe = chromium.executablePath(); } catch { /* ignore */ }
    if (!exe || !fs.existsSync(exe)) {
      return fail('SCRAPE_FAILED', `Chromium not installed for this Playwright version (run "npx playwright install chromium" on a machine that supports it)`);
    }

    let browser: any = null;
    try {
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
      const context = await browser.newContext({ userAgent: AppConfig.scraper.userAgent, locale: 'ar-SA' });
      const page = await context.newPage();
      const resp = await page.goto(AppConfig.scraper.targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const status = resp?.status() ?? 0;
      await page.waitForSelector('tr.project-row', { timeout: 15000 }).catch(() => undefined);
      const html = await page.content();
      const c = this.classify(status, 'text/html', html);
      return {
        meta: {
          transport: 'playwright', status: c.status, http_status: status, duration_ms: Date.now() - started,
          bytes: html.length, rows_found: c.rowsFound, page_title: c.pageTitle, error: c.error,
        },
        projects: c.projects,
      };
    } catch (e: any) {
      return fail('SCRAPE_FAILED', errorMessage(e).split('\n')[0]);
    } finally {
      if (browser) await browser.close().catch(() => undefined);
    }
  }

  // ── Helpers ────────────────────────────────────────────────

  private browserHeaders(): Record<string, string> {
    return {
      'User-Agent': AppConfig.scraper.userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Upgrade-Insecure-Requests': '1',
      'Referer': `${BASE_URL}/projects`,
    };
  }

  private buildRelayUrl(): string {
    const tpl = AppConfig.scraper.relayUrl;
    const target = encodeURIComponent(AppConfig.scraper.targetUrl);
    if (tpl.includes('{url}')) return tpl.replace('{url}', target);
    return `${tpl}${tpl.includes('?') ? '&' : '?'}url=${target}`;
  }

  private relayHeaders(): AxiosRequestConfig {
    const secret = AppConfig.scraper.relaySecret;
    return secret ? { headers: { 'X-Relay-Secret': secret } } : {};
  }

  private async proxyConfig(): Promise<AxiosRequestConfig> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { HttpsProxyAgent } = require('https-proxy-agent');
    const agent = new HttpsProxyAgent(AppConfig.scraper.proxyUrl);
    return { httpsAgent: agent, httpAgent: agent };
  }

  private getDirectCooldown(): string | null {
    if (AppConfig.scraper.blockCooldownMinutes <= 0) return null;
    try {
      const v = Database.getInstance().getSetting(COOLDOWN_KEY);
      if (v && new Date(v).getTime() > Date.now()) return v;
    } catch { /* DB down → no cooldown */ }
    return null;
  }

  private setDirectCooldown(): void {
    const mins = AppConfig.scraper.blockCooldownMinutes;
    if (mins <= 0) return;
    try {
      Database.getInstance().setSetting(COOLDOWN_KEY, new Date(Date.now() + mins * 60000).toISOString());
    } catch { /* non-critical */ }
  }

  private clearDirectCooldown(): void {
    try { Database.getInstance().deleteSetting(COOLDOWN_KEY); } catch { /* non-critical */ }
  }

  /** Describe transports for /api/status (no secrets). */
  describeTransports(): Record<string, unknown> {
    const cfg = AppConfig.scraper;
    return {
      target_url: cfg.targetUrl,
      direct: true,
      relay_configured: !!cfg.relayUrl,
      relay_host: cfg.relayUrl ? safeHost(cfg.relayUrl) : null,
      proxy_configured: !!cfg.proxyUrl,
      playwright_enabled: cfg.playwrightEnabled,
      direct_cooldown_until: this.getDirectCooldown(),
      timeout_ms: cfg.timeoutMs,
    };
  }
}

function safeHost(u: string): string {
  try { return new URL(u.replace('{url}', '')).host; } catch { return redact(u).slice(0, 40); }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
