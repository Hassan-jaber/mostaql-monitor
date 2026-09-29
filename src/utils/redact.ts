// ──────────────────────────────────────────────────────────────
// Secret redaction — every string that may reach logs, the DB or
// an API response passes through here first.
// ──────────────────────────────────────────────────────────────

const SECRET_ENV_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'ADMIN_TOKEN',
  'SCRAPER_RELAY_SECRET',
  'SCRAPER_PROXY_URL',
  'SCRAPER_RELAY_URL',
];

export function redact(input: unknown): string {
  let s = typeof input === 'string' ? input : safeStringify(input);

  // Telegram bot tokens anywhere (URL form and bare form)
  s = s.replace(/bot\d{5,}:[A-Za-z0-9_-]{20,}/g, 'bot<redacted>');
  s = s.replace(/\b\d{5,}:[A-Za-z0-9_-]{30,}\b/g, '<redacted-token>');

  // Credentials embedded in URLs: scheme://user:pass@host
  s = s.replace(/(\w+:\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1<redacted>@');

  // Common API-key query parameters
  s = s.replace(/([?&](?:api_key|apikey|key|token|secret|access_token)=)[^&\s"']+/gi, '$1<redacted>');

  // Exact values of known secret env vars
  for (const k of SECRET_ENV_KEYS) {
    const v = process.env[k];
    if (v && v.length >= 6) s = s.split(v).join(`<${k}>`);
  }
  return s;
}

/** Short, safe description of an error (never includes request config). */
export function errorMessage(err: any): string {
  if (!err) return 'unknown error';
  const code = err.code ? `${err.code}: ` : '';
  return redact(`${code}${err.message || String(err)}`).slice(0, 500);
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}
