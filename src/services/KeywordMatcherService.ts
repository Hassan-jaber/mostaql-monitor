import { ScrapedProject } from "../modules/types";
import { logger } from "../utils/logger";

const KEYWORDS_EN = [
  "html",
  "css",
  "javascript",
  "js",
  "typescript",
  "ts",
  "react",
  "reactjs",
  "react.js",
  "next.js",
  "nextjs",
  "next js",
  "vue",
  "vuejs",
  "vue.js",
  "nuxt",
  "angular",
  "svelte",
  "tailwind",
  "tailwindcss",
  "bootstrap",
  "material ui",
  "chakra",
  "figma",
  "figma to html",
  "figma to react",
  "psd to html",
  "xd to html",
  "adobe xd",
  "landing page",
  "landing-page",
  "portfolio",
  "portfolio website",
  "responsive",
  "responsive design",
  "pixel perfect",
  "ui developer",
  "ux developer",
  "ui/ux",
  "web design",
  "web designer",
  "web developer",
  "web development",
  "website design",
  "website redesign",
  "website",
  "static site",
  "static website",
  "frontend",
  "front-end",
  "front end",
  "single page application",
  "webflow",
  "animation",
  "vite",
  "webpack",
  "ssl",
  "prototype",
  "hostinger",
];

const KEYWORDS_AR = [
  "صفحة هبوط",
  "صفحة تعريفية",
  "صفحة ويب",
  "موقع تعريفي",
  "موقع شخصي",
  "موقع إلكتروني",
  "موقع الكتروني",
  "موقع بسيط",
  "تصميم موقع",
  "تطوير موقع",
  "برمجة موقع",
  "إنشاء موقع",
  "إضافة صفحات",
  "تحسين موقع",
  "إعادة تصميم",
  "تصميم صفحة",
  "فرونت اند",
  "مصمم ويب",
  "مطور واجهة",
  "مطور front-end",
  "مطور ويب",
  "واجهة مستخدم",
  "واجهة أمامية",
  "واجهة امامية",
  "واجهات أمامية",
  "واجهة",
  "تصميم واجهة",
  "تطوير واجهة",
  "تحويل تصميم",
  "تنفيذ تصميم",
  "تصميم ويب",
  "تصميم تعريفي",
  "موقع ويب",
  "شهادة ssl",
  "حجز دومين",
  "صفحة ويب بسيطة",
  "صفحة بسيطة",
  "مطور/مصمم",
  "مصمم UI/UX",
  "تصميم Landing Page",
  "موقع إلكتروني لشركة",
  "تصميم موقع شخصي",
  "انشاء صفحة هبوط",
  "سنديان",
  "مطور Frontend",
  "تصميم CSS",
  "تصميم وتنفيذ",
  "تصميم وتطوير",
  "هوستنجر",
  "تحسين تصميم",
  "موقع شخصي",
  "مصمم مواقع",
  "نشر صفحة",
  "تعديل موقع",
  "تحويل تصميم figma",
  "تحويل تصميم xd",
  "تحويل تصميم psd",
  "ترجمة موقع",
  "عمل صفحة",
  "تحديث وتطوير",
  "صناعة موقع",
  "صفحة رئيسية",
  "تحويل ملف فيجما",
  "متجاوبة",
  "تكويد",
  "منيو",
  "مطعم",
  "سلة",
  "متجر سلة",
  "صفحة واحدة",
  "استضافة",
  "إضافة اللغة الانجليزية",
  "إضافة اللغة العربية",
  "تصميم موقع متعدد اللغات",
  "تصميم موقع ثنائي اللغة",
  "تصميم موقع عربي وإنجليزي",
  "تصميم موقع عربي وانجليزي",
  "تصميم موقع عربي/إنجليزي",
  "تصميم موقع عربي وانجليزي",
  "تصميم موقع عربي-إنجليزي",
  "تصميم موقع عربي & إنجليزي",
  "موقع شركة",
  "موقع مؤسسة",
  "موقع لشركة",
  "موقع لمؤسسة",
  "موقع إلكتروني لشركة",
  "موقع إلكتروني لمؤسسة",
  "تصميم موقع لشركة",
  "تصميم موقع لمؤسسة",
  "تصميم موقع إلكتروني لشركة",
  "تصميم موقع إلكتروني لمؤسسة",
  "تصميم موقع لشركة",
  "تصميم موقع لمؤسسة",
  "موقع تفاعلي",
  "صفحة شخصية",
];

export class KeywordMatcherService {
  matchProject(project: ScrapedProject): {
    matched: boolean;
    keywords: string[];
  } {
    // ── Match ONLY against the project TITLE ─────────────────
    const searchText = (project.title || "")
      .toLowerCase()
      .replace(/[\u064B-\u065F]/g, "") // remove Arabic diacritics
      .replace(/\u200b/g, "")
      .replace(/[،,]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const matched: string[] = [];

    for (const kw of KEYWORDS_EN) {
      if (this.matchKeyword(searchText, kw.toLowerCase())) {
        matched.push(kw);
      }
    }

    for (const kw of KEYWORDS_AR) {
      if (searchText.includes(kw)) {
        matched.push(kw);
      }
    }

    const unique = [...new Set(matched)];

    if (unique.length > 0) {
      logger.info(
        `🎯 MATCH: "${project.title.slice(0, 60)}" → [${unique.join(", ")}]`,
      );
    }

    return { matched: unique.length > 0, keywords: unique };
  }

  private matchKeyword(text: string, keyword: string): boolean {
    if (text.includes(keyword)) return true;
    // Normalize: front-end → frontend, next.js → nextjs
    const textNorm = text.replace(/[-\s.]/g, "");
    const kwNorm = keyword.replace(/[-\s.]/g, "");
    if (kwNorm.length >= 3 && textNorm.includes(kwNorm)) return true;
    return false;
  }

  getKeywordStats(
    projects: Array<{ matched_keywords: string }>,
  ): Record<string, number> {
    const stats: Record<string, number> = {};
    for (const p of projects) {
      if (!p.matched_keywords) continue;
      try {
        const kws: string[] = JSON.parse(p.matched_keywords);
        for (const kw of kws) stats[kw] = (stats[kw] || 0) + 1;
      } catch {
        /* skip */
      }
    }
    return stats;
  }
}
