import * as cheerio from 'cheerio';
import { ScrapedProject } from '../modules/types';
import { logger } from '../utils/logger';

const BASE_URL = 'https://mostaql.com';
const TARGET_URL = `${BASE_URL}/projects?category=development&budget_max=10000&sort=latest`;

// ──────────────────────────────────────────────────────────────
// Confirmed real selectors from live HTML dump (mostaql-debug.html):
//
//   <tr class="project-row">
//     <td>
//       <h2 class="mrg--bt-reset">
//         <a href="/project/1243048-slug">TITLE</a>
//       </h2>
//       <p class="project__brief">
//         <a class="details-url" href="...">DESCRIPTION</a>
//       </p>
//     </td>
//   </tr>
//
// URL format: /project/NUMBER-slug  (NOT /projects/)
// ──────────────────────────────────────────────────────────────

export class MostaqlScraperService {

  async fetchLatestProjects(): Promise<ScrapedProject[]> {
    logger.info('📡 Fetching projects from Mostaql...');

    // On Hostinger: try axios first (no browser needed, lighter)
    // On local: Playwright works fine
    const axiosResult = await this.fetchWithAxios();
    if (axiosResult.length > 0) return axiosResult;

    // Playwright fallback (may not work on shared hosting)
    logger.info('🌐 axios returned 0 — trying Playwright...');
    return await this.fetchWithPlaywright();
  }

  // ── Axios (static HTML) ───────────────────────────────────
  private async fetchWithAxios(): Promise<ScrapedProject[]> {
    try {
      const axios = (await import('axios')).default;
      const resp = await axios.get(TARGET_URL, {
        timeout: 20000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ar-SA,ar;q=0.9,en-US;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'sec-ch-ua': '"Chromium";v="124","Google Chrome";v="124"',
          'sec-ch-ua-platform': '"Windows"',
          'Upgrade-Insecure-Requests': '1',
          'Cache-Control': 'no-cache',
        },
        validateStatus: () => true,
      });

      if (resp.status === 403) {
        logger.warn(`axios: 403 from Mostaql (Cloudflare blocking) — will try Playwright`);
        return [];
      }
      if (resp.status !== 200) {
        logger.warn(`axios: HTTP ${resp.status}`);
        return [];
      }

      const projects = this.parseHTML(resp.data);
      logger.info(`axios: parsed ${projects.length} projects`);
      return projects;
    } catch (e: any) {
      logger.warn(`axios error: ${e.message}`);
      return [];
    }
  }

  // ── Playwright (JS-rendered) ──────────────────────────────
  private async fetchWithPlaywright(): Promise<ScrapedProject[]> {
    let chromium: any;
    try {
      const pw = await import('playwright');
      chromium = pw.chromium;
    } catch {
      logger.error('Playwright not available — cannot scrape JS-rendered pages');
      return [];
    }

    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'ar-SA',
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: { 'Accept-Language': 'ar-SA,ar;q=0.9,en-US;q=0.8' },
    });

    const page = await context.newPage();
    await page.addInitScript("Object.defineProperty(navigator, 'webdriver', { get: () => undefined })");

    try {
      const resp = await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const status = resp?.status() ?? 0;

      if (status === 403) {
        logger.error('Playwright: 403 from Mostaql');
        await browser.close();
        return [];
      }

      try {
        await page.waitForSelector('tr.project-row', { timeout: 15000 });
        logger.info('✅ tr.project-row found in DOM');
      } catch {
        logger.warn('tr.project-row not found after 15s');
      }

      const html = await page.content();
      await browser.close();

      const projects = this.parseHTML(html);
      logger.info(`Playwright: parsed ${projects.length} projects`);
      return projects;

    } catch (e: any) {
      await browser.close();
      logger.error(`Playwright error: ${e.message}`);
      return [];
    }
  }

  // ── HTML parser — confirmed real selectors ─────────────────
  parseHTML(html: string): ScrapedProject[] {
    const $ = cheerio.load(html);
    const projects: ScrapedProject[] = [];
    const seen = new Set<string>();

    $('tr.project-row').each((_, el) => {
      const $row = $(el);

      // Title: h2.mrg--bt-reset > a
      const $link = $row.find('h2.mrg--bt-reset a').first();
      const title = $link.text().trim();
      if (!title || title.length < 3) return;

      // URL must contain /project/ (singular)
      const href = $link.attr('href') || '';
      if (!href.includes('/project/')) return;

      const url = href.startsWith('http') ? href : `${BASE_URL}${href}`;

      // ID from URL: /project/1243048-slug → 1243048
      const idMatch = url.match(/\/project\/(\d+)/);
      const projectId = idMatch ? idMatch[1] : this.hashId(url);

      if (seen.has(projectId)) return;
      seen.add(projectId);

      // Description: p.project__brief a.details-url
      const description = $row.find('p.project__brief a.details-url').first().text().trim().slice(0, 600)
        || $row.find('.text-wrapper-div a').first().text().trim().slice(0, 600);

      const posted_at = $row.find('time').attr('datetime');

      projects.push({
        project_id: projectId,
        title,
        url,
        budget: 'غير محدد',
        description,
        skills: [],
        posted_at,
      });
    });

    return projects;
  }

  async fetchProjectDetails(url: string): Promise<Partial<ScrapedProject>> {
    try {
      const axios = (await import('axios')).default;
      const resp = await axios.get(url, {
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0 Chrome/124.0.0.0' },
        validateStatus: () => true,
      });
      if (resp.status !== 200) return {};
      const $ = cheerio.load(resp.data);
      const description = $('.project-description, [itemprop="description"]').first().text().trim().slice(0, 1000);
      return { description: description || undefined };
    } catch { return {}; }
  }

  private hashId(input: string): string {
    let h = 0;
    for (let i = 0; i < input.length; i++) h = Math.imul(31, h) + input.charCodeAt(i) | 0;
    return Math.abs(h).toString();
  }
}
