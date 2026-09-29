import axios from 'axios';
import { ScrapedProject } from '../modules/types';
import { logger } from '../utils/logger';
import { AppConfig } from '../config/AppConfig';
import { redact, errorMessage } from '../utils/redact';

// ──────────────────────────────────────────────────────────────
// TelegramService
//
// • Credentials come ONLY from env vars (TELEGRAM_BOT_TOKEN,
//   TELEGRAM_CHAT_ID). They are never logged, stored or returned.
// • Messages use parse_mode=HTML with every dynamic value escaped.
//   (v3.1 used legacy Markdown without escaping, so any title or
//   description containing _ * [ or ` was rejected with HTTP 400
//   "can't parse entities".)
// • This service does not touch the database; the caller records
//   delivery state so a failed send is never marked as sent.
// ──────────────────────────────────────────────────────────────

export interface SendResult {
  ok: boolean;
  error?: string;
  /** Telegram error_code or HTTP status when available */
  code?: number;
}

type InlineKeyboard = Array<Array<{ text: string; url: string }>>;

const API = 'https://api.telegram.org';
const MAX_LEN = 4000;

export class TelegramService {

  private get token(): string { return AppConfig.telegram.botToken; }
  private get chatId(): string { return AppConfig.telegram.chatId; }

  isConfigured(): { ok: boolean; error?: string } {
    if (!this.token || !/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(this.token)) {
      return { ok: false, error: 'TELEGRAM_BOT_TOKEN is missing or malformed (expected "<digits>:<secret>")' };
    }
    if (!this.chatId) return { ok: false, error: 'TELEGRAM_CHAT_ID is missing' };
    return { ok: true };
  }

  /**
   * Send a project notification. Returns ok=true only when Telegram
   * accepted the main message. The second "copy" message is best-effort
   * and never causes a retry (which would duplicate the main message).
   */
  async sendMatchNotification(project: ScrapedProject, keywords: string[]): Promise<SendResult> {
    const cfg = this.isConfigured();
    if (!cfg.ok) {
      logger.error(`❌ Telegram not configured: ${cfg.error}`);
      return { ok: false, error: cfg.error };
    }

    const main = await this.sendMessage(this.buildInfoMessage(project, keywords), [
      [{ text: '🔗 فتح المشروع', url: project.url }],
    ]);
    if (!main.ok) {
      logger.error(`❌ Telegram send failed for ${project.project_id}: ${main.error}`);
      return main;
    }

    const copy = await this.sendMessage(this.buildCopyMessage(project, keywords));
    if (!copy.ok) logger.warn(`Telegram copy-message failed for ${project.project_id} (main message was delivered): ${copy.error}`);

    logger.info(`✅ Telegram sent: "${project.title.slice(0, 80)}"`);
    return { ok: true };
  }

  /** Operational alert (scraper down / recovered). */
  async sendAlert(text: string): Promise<SendResult> {
    const cfg = this.isConfigured();
    if (!cfg.ok) return { ok: false, error: cfg.error };
    return this.sendMessage(text);
  }

  async testConnection(): Promise<{ success: boolean; status: string; info?: string; error?: string }> {
    const cfg = this.isConfigured();
    if (!cfg.ok) return { success: false, status: 'TELEGRAM_NOT_CONFIGURED', error: cfg.error };

    try {
      const r = await axios.get(`${API}/bot${this.token}/getMe`, { timeout: 8000, validateStatus: () => true });
      if (!r.data?.ok) {
        return { success: false, status: 'TELEGRAM_FAILED', error: this.describeApiError(r.status, r.data) };
      }
      const bot = r.data.result;
      const sent = await this.sendMessage('✅ <b>Mostaql Monitor</b> — Telegram connection test successful.');
      if (!sent.ok) {
        return { success: false, status: 'TELEGRAM_FAILED', error: `Bot @${bot.username} is valid, but sending to the chat failed: ${sent.error}` };
      }
      return { success: true, status: 'SUCCESS', info: `@${bot.username} — test message delivered` };
    } catch (e: any) {
      return { success: false, status: 'TELEGRAM_FAILED', error: errorMessage(e) };
    }
  }

  // ── Low-level send with one 429 retry ──────────────────────

  private async sendMessage(text: string, keyboard?: InlineKeyboard): Promise<SendResult> {
    const parts = text.length <= MAX_LEN ? [text] : this.splitText(text, MAX_LEN);

    for (let i = 0; i < parts.length; i++) {
      const body: Record<string, unknown> = {
        chat_id: this.chatId,
        text: parts[i],
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      };
      if (i === parts.length - 1 && keyboard) body.reply_markup = { inline_keyboard: keyboard };

      let res = await this.post(body);
      if (!res.ok && res.code === 429 && res.retryAfter && res.retryAfter <= 15) {
        await new Promise(r => setTimeout(r, res.retryAfter! * 1000));
        res = await this.post(body);
      }
      if (!res.ok) return { ok: false, error: res.error, code: res.code };
    }
    return { ok: true };
  }

  private async post(body: Record<string, unknown>): Promise<SendResult & { retryAfter?: number }> {
    try {
      const r = await axios.post(`${API}/bot${this.token}/sendMessage`, body, {
        timeout: AppConfig.telegram.timeoutMs,
        validateStatus: () => true,
      });
      if (r.data?.ok) return { ok: true };
      return {
        ok: false,
        code: r.data?.error_code ?? r.status,
        error: this.describeApiError(r.status, r.data),
        retryAfter: r.data?.parameters?.retry_after,
      };
    } catch (e: any) {
      const timedOut = e?.code === 'ECONNABORTED' || /timeout/i.test(e?.message || '');
      return { ok: false, error: timedOut ? `Telegram timeout after ${AppConfig.telegram.timeoutMs}ms` : errorMessage(e) };
    }
  }

  private describeApiError(status: number, data: any): string {
    const desc = redact(data?.description || `HTTP ${status}`);
    const code = data?.error_code ?? status;
    if (code === 401) return `401 Unauthorized — TELEGRAM_BOT_TOKEN is invalid or revoked (${desc})`;
    if (code === 403) return `403 Forbidden — bot was blocked or removed from the chat (${desc})`;
    if (code === 400 && /chat not found/i.test(desc)) return `400 chat not found — check TELEGRAM_CHAT_ID and that you pressed Start in the bot chat`;
    if (code === 429) return `429 Too Many Requests (${desc})`;
    return `${code} ${desc}`;
  }

  // ── Message builders (HTML, escaped) ───────────────────────

  private buildInfoMessage(project: ScrapedProject, keywords: string[]): string {
    const description = (project.description || '').trim().slice(0, 400);
    const kwLine = keywords.slice(0, 6).join(', ');
    let msg = `🚀 <b>مشروع Front-End جديد على مستقل</b>\n\n`;
    msg += `📌 <b>العنوان:</b>\n${esc(project.title)}\n\n`;
    msg += `💰 <b>الميزانية:</b> ${esc(project.budget || 'غير محدد')}\n\n`;
    if (description) msg += `📝 <b>الوصف:</b>\n${esc(description)}\n\n`;
    msg += `🎯 <b>الكلمات المطابقة:</b> ${esc(kwLine)}\n\n`;
    msg += `🔗 ${esc(project.url)}`;
    return msg;
  }

  private buildCopyMessage(project: ScrapedProject, keywords: string[]): string {
    const description = (project.description || '').trim().slice(0, 400);
    const kwLine = keywords.slice(0, 6).join(', ');
    let content = `🚀 مشروع Front-End جديد على مستقل\n`;
    content += `📌 العنوان:\n${project.title}\n`;
    content += `💰 الميزانية: ${project.budget || 'غير محدد'}\n`;
    if (description) content += `📝 الوصف:\n${description}\n`;
    content += `🎯 الكلمات المطابقة: ${kwLine}\n`;
    content += `🔗 ${project.url}`;
    return `📋 اضغط على النص أدناه لنسخه:\n<pre>${esc(content)}</pre>`;
  }

  private splitText(text: string, max: number): string[] {
    const parts: string[] = [];
    let rem = text;
    while (rem.length > max) {
      const cut = rem.lastIndexOf('\n', max);
      const at = cut > max / 2 ? cut : max;
      parts.push(rem.slice(0, at));
      rem = rem.slice(at).trimStart();
    }
    if (rem) parts.push(rem);
    return parts;
  }
}

/** Escape for Telegram parse_mode=HTML. */
export function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
