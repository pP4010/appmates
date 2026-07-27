/**
 * Screenshot relay: the one thing the static web app cannot do from the
 * browser.
 *
 * `itunes.apple.com/lookup` and `/search` withhold `screenshotUrls` for some
 * apps regardless of country or endpoint — confirmed by hand against a real
 * listing. The real product page at `apps.apple.com` embeds the same images,
 * at full resolution, in an internal JSON blob that backs its current web
 * frontend. That page sends no CORS headers, so the browser cannot fetch it
 * directly (unlike the iTunes catalogue, which does) — a server has to.
 *
 * This is a relay, not a proxy: it takes an app id and a country code, both
 * already public, and returns already-public screenshot URLs. Nothing a
 * caller sends is stored, logged, or forwarded anywhere beyond the one
 * outbound request to Apple. Mirrors the same extraction the Python CLI does
 * in `core/clients/itunes.py::fetch_page_screenshots` — the two are kept in
 * sync by hand since a Worker cannot share code with the Python package.
 */

const APP_PAGE_URL = (country, trackId) => `https://apps.apple.com/${country}/app/id${trackId}`;

const USER_AGENT = 'launchpilot-screenshot-relay/1.0 (+https://github.com/pP4010/launchpilot)';

const SERVER_DATA_RE =
  /<script type="application\/json" id="serialized-server-data">([\s\S]*?)<\/script>/;

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
};

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS, ...init.headers },
  });
}

const EMPTY = { iphone: [], ipad: [] };

/** Extracted URLs for one shelf (`product_media_phone_` or `..._pad_`). */
function urlsFor(shelf, shelfKey) {
  const items = shelf?.[shelfKey]?.items ?? [];
  const found = [];
  for (const item of items) {
    const shot = item?.screenshot;
    const template = shot?.template;
    const { width, height } = shot ?? {};
    if (typeof template === 'string' && width && height) {
      found.push(
        template.replace('{w}', width).replace('{h}', height).replace('{c}', 'bb').replace('{f}', 'jpg'),
      );
    }
  }
  return found;
}

/**
 * Pull screenshots out of the product page HTML.
 *
 * The blob is not a public contract — any shape mismatch degrades to
 * `EMPTY` rather than throwing, so a change on Apple's side falls back to
 * "not exposed", the same outcome the catalogue already produces for this
 * app, instead of a 500.
 */
function extractScreenshots(html) {
  const match = SERVER_DATA_RE.exec(html);
  if (!match) return EMPTY;

  let payload;
  try {
    payload = JSON.parse(match[1]);
  } catch {
    return EMPTY;
  }

  const shelf = payload?.data?.[0]?.data?.shelfMapping;
  if (!shelf || typeof shelf !== 'object') return EMPTY;

  return {
    iphone: urlsFor(shelf, 'product_media_phone_'),
    ipad: urlsFor(shelf, 'product_media_pad_'),
  };
}

const ID_RE = /^\d+$/;
const COUNTRY_RE = /^[a-z]{2}$/;

export default {
  async fetch(request, _env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    if (request.method !== 'GET') {
      return json({ error: 'GET only' }, { status: 405 });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/screenshots') {
      return json({ error: 'not found' }, { status: 404 });
    }

    const id = url.searchParams.get('id') ?? '';
    const country = (url.searchParams.get('country') ?? 'us').toLowerCase();
    if (!ID_RE.test(id) || !COUNTRY_RE.test(country)) {
      return json({ error: 'id must be numeric; country must be a 2-letter code' }, { status: 400 });
    }

    // Public data, keyed only by the two public inputs — a normal HTTP cache
    // in front of Apple, not a store of anything a caller sent. The Cache API
    // is local to whichever Cloudflare data centre serves the request, not
    // shared globally, so this only ever saves a repeat trip to Apple from
    // the same region — it never risks papering over a real failure for
    // callers elsewhere.
    const cache = caches.default;
    const cacheKey = new Request(new URL(`/cache/${country}/${id}`, url.origin));
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const html = await fetchPage(APP_PAGE_URL(country, id));
    const result = html ? extractScreenshots(html) : EMPTY;
    const response = json(result);

    // Apple's page is rate-limited, and a rate-limited or otherwise empty
    // result is never cached: an app that genuinely has no screenshots would
    // always look the same, but a transient failure would otherwise get
    // stuck as "not found" at this data centre for the full TTL. Caching
    // only successes means the very next request retries fresh instead.
    if (result.iphone.length || result.ipad.length) {
      const toCache = json(result, { headers: { 'cache-control': 'public, max-age=43200' } });
      ctx.waitUntil(cache.put(cacheKey, toCache));
    }
    return response;
  },
};

/**
 * Fetch the product page, retrying once on a 429.
 *
 * Apple throttles this page under load, and Cloudflare's own IP ranges are a
 * shared pool every deployment of this relay fetches from — a request that
 * lands on Apple mid-throttle is common enough to be worth one retry rather
 * than reporting a real listing's screenshots as "not found".
 */
async function fetchPage(url) {
  for (const delayMs of [0, 500]) {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    let response;
    try {
      response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
    } catch {
      continue;
    }
    if (response.ok) return response.text();
    if (response.status !== 429) return null;
  }
  return null;
}
