import { ScrapedProject } from '../modules/types';
import { logger } from '../utils/logger';

const KEYWORDS_EN = [
  'html', 'css', 'javascript', 'typescript',
  'react', 'reactjs', 'react.js',
  'next.js', 'nextjs', 'next js',
  'vue', 'vuejs', 'nuxt', 'angular', 'svelte',
  'tailwind', 'tailwindcss', 'bootstrap', 'sass', 'scss',
  'material ui', 'shadcn', 'chakra',
  'figma', 'figma to html', 'figma to react',
  'psd to html', 'xd to html', 'adobe xd',
  'landing page', 'landing-page',
  'portfolio', 'portfolio website',
  'responsive', 'responsive design',
  'pixel perfect', 'ui developer', 'ux developer', 'ui/ux',
  'web design', 'web designer',
  'web developer', 'web development',
  'website design', 'website redesign', 'website',
  'static site', 'static website',
  'frontend', 'front-end', 'front end',
  'single page application',
  'shopify', 'wordpress theme', 'webflow', 'wix',
  'animation', 'gsap', 'framer motion',
  'vite', 'webpack',
  'prototype', 'mockup', 'wireframe',
  'mvp', 'interactive prototype',
];

const KEYWORDS_AR = [
  'صفحة هبوط', 'صفحة تعريفية', 'صفحة ويب', 'صفحة رئيسية', 'صفحة بسيطة', 'صفحة واحدة', 'صفحة شخصية',
  'موقع تعريفي', 'موقع شخصي', 'موقع إلكتروني', 'موقع الكتروني', 'موقع بسيط', 'موقع ويب',
  'موقع لشركة', 'موقع لمؤسسة', 'موقع شركة', 'موقع مؤسسة', 'موقع تفاعلي',
  'تصميم موقع', 'تطوير موقع', 'برمجة موقع', 'إنشاء موقع', 'انشاء موقع', 'صناعة موقع',
  'إضافة صفحات', 'تحسين موقع', 'إعادة تصميم', 'تصميم صفحة', 'تعديل موقع', 'نشر صفحة',
  'تحديث وتطوير', 'تصميم وتنفيذ', 'تصميم وتطوير',
  'فرونت اند', 'مصمم ويب', 'مطور واجهة', 'مطور ويب', 'مصمم مواقع',
  'واجهة مستخدم', 'واجهة أمامية', 'واجهة امامية', 'واجهات أمامية', 'واجهة', 'تصميم واجهة', 'تطوير واجهة',
  'تحويل تصميم', 'تنفيذ تصميم', 'تصميم ويب',
  'تحويل تصميم figma', 'تحويل تصميم xd', 'تحويل تصميم psd', 'تحويل ملف فيجما',
  'شوبيفاي', 'ووردبريس',
  'تصميم Landing Page', 'مطور Frontend', 'مصمم UI/UX',
  'متجاوبة', 'تكويد',
  'سلة', 'متجر سلة',
  'استضافة', 'هوستنجر',
  'موقع إلكتروني لشركة', 'موقع إلكتروني لمؤسسة',
  'موقع متعدد اللغات', 'موقع ثنائي اللغة', 'موقع عربي وإنجليزي',
];

export class KeywordMatcherService {

  matchProject(project: ScrapedProject): { matched: boolean; keywords: string[] } {
    // Match ONLY against the project TITLE
    const searchText = (project.title || '')
      .toLowerCase()
      .replace(/[\u064B-\u065F]/g, '') // Arabic diacritics
      .replace(/\u200b/g, '')
      .replace(/[،,]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const matched: string[] = [];

    for (const kw of KEYWORDS_EN) {
      if (this.matchKeyword(searchText, kw.toLowerCase())) matched.push(kw);
    }
    for (const kw of KEYWORDS_AR) {
      if (searchText.includes(kw)) matched.push(kw);
    }

    const unique = [...new Set(matched)];
    if (unique.length > 0) {
      logger.info(`🎯 MATCH: "${project.title.slice(0, 60)}" → [${unique.join(', ')}]`);
    }

    return { matched: unique.length > 0, keywords: unique };
  }

  private matchKeyword(text: string, keyword: string): boolean {
    if (text.includes(keyword)) return true;
    const textNorm = text.replace(/[-\s.]/g, '');
    const kwNorm = keyword.replace(/[-\s.]/g, '');
    if (kwNorm.length >= 3 && textNorm.includes(kwNorm)) return true;
    return false;
  }

  getKeywordStats(projects: Array<{ matched_keywords: string }>): Record<string, number> {
    const stats: Record<string, number> = {};
    for (const p of projects) {
      if (!p.matched_keywords) continue;
      try {
        const kws: string[] = JSON.parse(p.matched_keywords);
        for (const kw of kws) stats[kw] = (stats[kw] || 0) + 1;
      } catch { /* skip */ }
    }
    return stats;
  }
}
