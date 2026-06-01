import * as cheerio from 'cheerio';
import { ScrapedProject } from '../modules/types';
import { logger } from '../utils/logger';

// ──────────────────────────────────────────────────────────────
// MostaqlScraperService — built from the REAL HTML structure
//
// Confirmed from live HTML dump (mostaql-debug.html):
//
//   <tr class="project-row">
//     <td class="row-td">
//       <div class="card-title_wrapper">
//         <div class="card--title">
//           <h2 class="mrg--bt-reset">
//             <a href="https://mostaql.com/project/1243048-slug">TITLE</a>
//           </h2>
//         </div>
//       </div>
//       <p class="text-wrapper-div project__brief">
//         <a href="..." class="details-url">DESCRIPTION TEXT</a>
//       </p>
//     </td>
//   </tr>
//
// Key facts:
// - URL format: /project/NUMBER-slug  (NOT /projects/)
// - No budget column in the list — must fetch project page for budget
// - No skills/tags in list — only in project detail page
// ──────────────────────────────────────────────────────────────

const BASE_URL = 'https://mostaql.com';

export class MostaqlScraperService {

  async fetchLatestProjects(): Promise<ScrapedProject[]> {
    logger.info('📡 Fetching projects from Mostaql (browser mode)...');
    try {
      return await this.fetchWithPlaywright();
    } catch (err: any) {
      logger.error('Playwright fetch failed: ' + err.message);
      return [];
    }
  }

  // ── Playwright: renders JS, waits for project rows ─────────
  private async fetchWithPlaywright(): Promise<ScrapedProject[]> {
    const { chromium } = await import('playwright');

    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'ar-SA',
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: {
        'Accept-Language': 'ar-SA,ar;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });

    const page = await context.newPage();
    await page.addInitScript(
      "Object.defineProperty(navigator, 'webdriver', { get: () => undefined })"
    );

    try {
      logger.info('🌐 Opening browser → mostaql.com/projects');

      const response = await page.goto(`${BASE_URL}/projects?category=development&budget_max=10000&sort=latest`, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });

      const status = response?.status() ?? 0;
      if (status === 403 || status === 429) {
        logger.error(`❌ Mostaql returned HTTP ${status} — your IP may be blocked`);
        await browser.close();
        return [];
      }

      // Wait for the confirmed real selector: tr.project-row
      try {
        await page.waitForSelector('tr.project-row', { timeout: 15000 });
        logger.info('✅ tr.project-row elements found in DOM');
      } catch {
        // Try waiting a bit longer with networkidle
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        const count = await page.locator('tr.project-row').count();
        if (count === 0) {
          logger.warn('⚠️  tr.project-row not found — saving debug HTML');
          const dbgHtml = await page.content();
          require('fs').writeFileSync('./debug-latest.html', dbgHtml);
          logger.warn('Saved to ./debug-latest.html');
        }
      }

      const html = await page.content();
      await browser.close();

      const projects = this.parseHTML(html);
      logger.info(`✅ Parsed ${projects.length} projects`);
      return projects;

    } catch (err: any) {
      await browser.close();
      throw err;
    }
  }

  // ── HTML parser using confirmed real selectors ─────────────
  parseHTML(html: string): ScrapedProject[] {
    const $ = cheerio.load(html);
    const projects: ScrapedProject[] = [];
    const seen = new Set<string>();

    // CONFIRMED SELECTOR: tr.project-row
    $('tr.project-row').each((_, el) => {
      const $row = $(el);

      // ── Title ──────────────────────────────────────────────
      // CONFIRMED: h2.mrg--bt-reset > a
      const $titleLink = $row.find('h2.mrg--bt-reset a').first();
      const title = $titleLink.text().trim();
      if (!title || title.length < 3) return;

      // ── URL ────────────────────────────────────────────────
      // CONFIRMED: href="https://mostaql.com/project/NUMBER-slug"
      const href = $titleLink.attr('href') || '';
      if (!href.includes('/project/')) return; // skip "مشروع مماثل" links

      const url = href.startsWith('http') ? href : `${BASE_URL}${href}`;

      // ── Project ID ─────────────────────────────────────────
      // CONFIRMED: /project/1243048-slug → ID = 1243048
      const idMatch = url.match(/\/project\/(\d+)/);
      const projectId = idMatch ? idMatch[1] : this.hashId(url);

      if (seen.has(projectId)) return;
      seen.add(projectId);

      // ── Description ────────────────────────────────────────
      // CONFIRMED: p.project__brief a.details-url
      const $brief = $row.find('p.project__brief a.details-url').first();
      const description = $brief.text().trim().slice(0, 600);

      // Also try the text-wrapper-div variant
      const $briefAlt = $row.find('.text-wrapper-div a').first();
      const finalDescription = description || $briefAlt.text().trim().slice(0, 600);

      // ── Time posted ────────────────────────────────────────
      const posted_at = $row.find('time').attr('datetime') || undefined;

      projects.push({
        project_id: projectId,
        title,
        url,
        budget: 'غير محدد', // Budget not in list — fetched separately if needed
        description: finalDescription,
        skills: [],
        posted_at,
      });
    });

    return projects;
  }

  // ── Fetch individual project page for budget + skills ──────
  async fetchProjectDetails(url: string): Promise<Partial<ScrapedProject>> {
    try {
      const axios = (await import('axios')).default;
      const resp = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
          'Accept-Language': 'ar-SA,ar;q=0.9',
        },
        validateStatus: () => true,
      });

      if (resp.status !== 200) return {};

      const $ = cheerio.load(resp.data);

      // Budget — several possible locations on project detail page
      const budgetSelectors = [
        '.budget-box strong',
        '.budget-box',
        '[class*="budget"]',
        '[class*="price"]',
        '.crl-budget',
        'span.budget',
      ];
      let budget = '';
      for (const sel of budgetSelectors) {
        const t = $(sel).first().text().trim();
        if (t && t.length < 80) { budget = t; break; }
      }

      // Skills
      const skills: string[] = [];
      $('[class*="skill"] a, [class*="tag"] a, .badge').each((_, el) => {
        const t = $(el).text().trim();
        if (t && t.length < 80 && t.length > 1) skills.push(t);
      });

      // Full description from detail page
      const fullDesc = $(
        '.project-description, [itemprop="description"], .project__description'
      ).first().text().trim().slice(0, 1000);

      return {
        budget: budget || undefined,
        skills: skills.length ? skills : undefined,
        description: fullDesc || undefined,
      };
    } catch {
      return {};
    }
  }

  private hashId(input: string): string {
    let h = 0;
    for (let i = 0; i < input.length; i++) h = Math.imul(31, h) + input.charCodeAt(i) | 0;
    return Math.abs(h).toString();
  }
}
