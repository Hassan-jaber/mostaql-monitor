import axios from 'axios';
import { ScrapedProject } from '../modules/types';
import { logger } from '../utils/logger';
import { Database } from '../database/Database';

export class TelegramService {
  private getSetting(key: string): string {
    const row = Database.getInstance().queryOne<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?', [key]
    );
    return row?.value || '';
  }

  async sendMatchNotification(
    project: ScrapedProject,
    keywords: string[]
  ): Promise<boolean> {
    const botToken = this.getSetting('telegram_bot_token');
    const chatId = this.getSetting('telegram_chat_id');

    if (!botToken || botToken.length < 10) {
      logger.warn('⚠️  Telegram bot token not configured');
      return false;
    }
    if (!chatId) {
      logger.warn('⚠️  Telegram chat ID not configured');
      return false;
    }

    // الرسالة الأولى — معلومات المشروع + زر فتح
    const infoMessage = this.buildInfoMessage(project, keywords);

    // الرسالة الثانية — نفس المحتوى داخل code block لنسخه بضغطة واحدة
    const copyMessage = this.buildCopyMessage(project, keywords);

    try {
      // إرسال رسالة المعلومات مع زر فتح المشروع
      await this.sendMessage(botToken, chatId, infoMessage, [
        [{ text: '🔗 فتح المشروع', url: project.url }],
      ]);

      // إرسال رسالة النسخ كـ code block
      await this.sendMessage(botToken, chatId, copyMessage);

      Database.getInstance().run(
        `INSERT INTO notifications (project_id, telegram_status, sent_at) VALUES (?, 'sent', datetime('now'))`,
        [project.project_id]
      );
      Database.getInstance().run(
        `UPDATE projects SET sent_at = datetime('now') WHERE project_id = ?`,
        [project.project_id]
      );

      logger.info(`📨 Telegram sent: "${project.title}"`);
      return true;
    } catch (err: any) {
      const msg = err?.response?.data?.description || err.message || 'unknown';
      logger.error(`❌ Telegram failed for "${project.title}": ${msg}`);
      Database.getInstance().run(
        `INSERT INTO notifications (project_id, telegram_status, error_message, sent_at) VALUES (?, 'failed', ?, datetime('now'))`,
        [project.project_id, msg]
      );
      return false;
    }
  }

  // رسالة المعلومات — نص عادي
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

  // رسالة النسخ — نفس المحتوى داخل ``` لتظهر زر النسخ تلقائياً
  private buildCopyMessage(project: ScrapedProject, keywords: string[]): string {
    const description = (project.description || '').trim().slice(0, 400);
    const kwLine = keywords.slice(0, 6).join(', ');

    let content = `🚀 مشروع Front-End جديد على مستقل\n`;
    content += `📌 العنوان:\n${project.title}\n`;
    content += `💰 الميزانية: ${project.budget || 'غير محدد'}\n`;
    if (description) content += `📝 الوصف:\n${description}\n`;
    content += `🎯 الكلمات المطابقة: ${kwLine}\n`;
    content += `🔗 ${project.url}`;

    // اضغط على الكود لنسخه ← يظهر بشكل تلقائي في Telegram
    return `📋 اضغط على الرسالة أدناه لنسخها:\n\`\`\`\n${content}\n\`\`\``;
  }

  private async sendMessage(
    token: string,
    chatId: string,
    text: string,
    inlineKeyboard?: Array<Array<{ text: string; url?: string; callback_data?: string }>>
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
    let remaining = text;
    while (remaining.length > max) {
      const cut = remaining.lastIndexOf('\n', max);
      const at = cut > max / 2 ? cut : max;
      parts.push(remaining.slice(0, at));
      remaining = remaining.slice(at).trimStart();
    }
    if (remaining) parts.push(remaining);
    return parts;
  }

  async testConnection(): Promise<{ success: boolean; info?: string; error?: string }> {
    const token = this.getSetting('telegram_bot_token');
    if (!token) return { success: false, error: 'Bot token not set' };
    try {
      const r = await axios.get(`https://api.telegram.org/bot${token}/getMe`, { timeout: 8000 });
      const bot = r.data?.result;
      return { success: true, info: `@${bot.username} (${bot.first_name})` };
    } catch (e: any) {
      return { success: false, error: e?.response?.data?.description || e.message };
    }
  }
}
