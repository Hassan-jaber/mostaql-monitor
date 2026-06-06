import axios from 'axios';
import { ScrapedProject } from '../modules/types';
import { logger } from '../utils/logger';
import { Database } from '../database/Database';
import { AppConfig } from '../config/AppConfig';

// ──────────────────────────────────────────────────────────────
// TelegramService
//
// CRITICAL FIX: credentials are read from AppConfig (env vars)
// NOT from the database. This ensures notifications work even
// if DB initialization fails on Hostinger.
//
// Priority: env var → DB setting → empty (fail gracefully)
// ──────────────────────────────────────────────────────────────
export class TelegramService {

  private getToken(): string {
    // 1. Try env var first (always works, even if DB fails)
    if (AppConfig.telegram.botToken) return AppConfig.telegram.botToken;
    // 2. Fallback to DB setting
    try {
      const row = Database.getInstance().queryOne<{ value: string }>(
        'SELECT value FROM settings WHERE key = ?', ['telegram_bot_token']
      );
      return row?.value || '';
    } catch { return ''; }
  }

  private getChatId(): string {
    if (AppConfig.telegram.chatId) return AppConfig.telegram.chatId;
    try {
      const row = Database.getInstance().queryOne<{ value: string }>(
        'SELECT value FROM settings WHERE key = ?', ['telegram_chat_id']
      );
      return row?.value || '';
    } catch { return ''; }
  }

  async sendMatchNotification(project: ScrapedProject, keywords: string[]): Promise<boolean> {
    const botToken = this.getToken();
    const chatId = this.getChatId();

    logger.info(`📬 Attempting Telegram — token: ${botToken ? botToken.slice(0,8) + '***' : 'MISSING'}, chatId: ${chatId || 'MISSING'}`);

    if (!botToken || botToken.length < 10) {
      logger.error('❌ TELEGRAM_BOT_TOKEN is not set or too short. Set it as environment variable.');
      return false;
    }
    if (!chatId) {
      logger.error('❌ TELEGRAM_CHAT_ID is not set. Set it as environment variable.');
      return false;
    }

    const infoMsg = this.buildInfoMessage(project, keywords);
    const copyMsg = this.buildCopyMessage(project, keywords);

    try {
      // Message 1: project info + open button
      await this.sendMessage(botToken, chatId, infoMsg, [
        [{ text: '🔗 فتح المشروع', url: project.url }],
      ]);

      // Message 2: copyable code block
      await this.sendMessage(botToken, chatId, copyMsg);

      // Record in DB (non-fatal if fails)
      try {
        Database.getInstance().run(
          `INSERT INTO notifications (project_id, telegram_status, sent_at) VALUES (?, 'sent', datetime('now'))`,
          [project.project_id]
        );
        Database.getInstance().run(
          `UPDATE projects SET sent_at = datetime('now') WHERE project_id = ?`,
          [project.project_id]
        );
      } catch { /* DB write failure is non-fatal */ }

      logger.info(`✅ Telegram sent: "${project.title}"`);
      return true;

    } catch (err: any) {
      const msg = err?.response?.data?.description || err?.response?.data || err.message || 'unknown';
      logger.error(`❌ Telegram API error: ${JSON.stringify(msg)}`);
      try {
        Database.getInstance().run(
          `INSERT INTO notifications (project_id, telegram_status, error_message) VALUES (?, 'failed', ?)`,
          [project.project_id, String(msg)]
        );
      } catch { /* ignore */ }
      return false;
    }
  }

  private buildInfoMessage(project: ScrapedProject, keywords: string[]): string {
    const description = (project.description || '').trim().slice(0, 400);
    const kwLine = keywords.slice(0, 6).join(', ');
    let msg = `🚀 مشروع Front-End جديد على مستقل\n\n`;
    msg += `📌 العنوان:\n${project.title}\n\n`;
    msg += `💰 الميزانية: ${project.budget || 'غير محدد'}\n\n`;
    if (description) msg += `📝 الوصف:\n${description}\n\n`;
    msg += `🎯 الكلمات المطابقة: ${kwLine}\n\n`;
    msg += `🔗 ${project.url}`;
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
    return `📋 اضغط على النص أدناه لنسخه:\n\`\`\`\n${content}\n\`\`\``;
  }

  private async sendMessage(
    token: string,
    chatId: string,
    text: string,
    inlineKeyboard?: Array<Array<{ text: string; url?: string }>>
  ): Promise<void> {
    const MAX = 4000;
    const parts = text.length <= MAX ? [text] : this.splitText(text, MAX);

    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const body: Record<string, unknown> = {
        chat_id: chatId,
        text: parts[i],
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      };
      if (isLast && inlineKeyboard) {
        body.reply_markup = { inline_keyboard: inlineKeyboard };
      }
      await axios.post(
        `https://api.telegram.org/bot${token}/sendMessage`,
        body,
        { timeout: 15000 }
      );
    }
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

  async testConnection(): Promise<{ success: boolean; info?: string; error?: string }> {
    const token = this.getToken();
    const chatId = this.getChatId();

    if (!token) return { success: false, error: 'TELEGRAM_BOT_TOKEN not set in environment variables' };
    if (!chatId) return { success: false, error: 'TELEGRAM_CHAT_ID not set in environment variables' };

    try {
      const r = await axios.get(`https://api.telegram.org/bot${token}/getMe`, { timeout: 8000 });
      const bot = r.data?.result;

      // Send test message
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text: '✅ Mostaql Monitor — Telegram connection test successful!',
      }, { timeout: 8000 });

      return { success: true, info: `@${bot.username} — test message sent to ${chatId}` };
    } catch (e: any) {
      return { success: false, error: e?.response?.data?.description || e.message };
    }
  }
}
