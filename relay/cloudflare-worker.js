/**
 * Mostaql relay — Cloudflare Worker (free plan is enough).
 *
 * Why: Mostaql refuses requests coming from some datacenter IPs (the
 * Hostinger server gets blocked). This Worker fetches the listing from
 * Cloudflare's network and returns the raw HTML plus the real upstream
 * HTTP status, so the monitor can still classify BLOCKED / FAILED.
 *
 * Deploy:
 *   1. dash.cloudflare.com → Workers & Pages → Create → "Hello World" Worker
 *   2. Replace the code with this file → Deploy
 *   3. Settings → Variables and Secrets → add Secret  RELAY_SECRET = <random string>
 *   4. On Hostinger set:
 *        SCRAPER_RELAY_URL=https://<worker-name>.<subdomain>.workers.dev/
 *        SCRAPER_RELAY_SECRET=<same random string>
 *
 * Quick check in a browser (temporarily without secret, or with curl):
 *   curl -H "X-Relay-Secret: <secret>" \
 *     "https://<worker>.workers.dev/?url=https%3A%2F%2Fmostaql.com%2Fprojects"
 *   → HTTP 200 and HTML containing  class="project-row"  means it works.
 *
 * Security: only https://mostaql.com URLs are relayed, and a shared secret
 * is required when RELAY_SECRET is configured.
 */

const ALLOWED_HOSTS = new Set(['mostaql.com', 'www.mostaql.com']);

export default {
  async fetch(request, env) {
    if (request.method !== 'GET') {
      return new Response('relay: method not allowed', { status: 405 });
    }

    if (env.RELAY_SECRET && request.headers.get('X-Relay-Secret') !== env.RELAY_SECRET) {
      return new Response('relay: unauthorized (bad or missing X-Relay-Secret)', { status: 401 });
    }

    const target = new URL(request.url).searchParams.get('url');
    let url;
    try { url = new URL(target || ''); } catch {
      return new Response('relay: missing or invalid ?url=', { status: 400 });
    }
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
      return new Response('relay: host not allowed', { status: 400 });
    }

    const upstream = await fetch(url.toString(), {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
      },
      cf: { cacheTtl: 0, cacheEverything: false },
    });

    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') || 'text/html; charset=UTF-8',
        'cache-control': 'no-store',
        'x-upstream-status': String(upstream.status),
      },
    });
  },
};
