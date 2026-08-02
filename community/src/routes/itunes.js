import { json, error } from '../lib/http.js';

const LOOKUP_URL = 'https://itunes.apple.com/lookup';
const SEARCH_URL = 'https://itunes.apple.com/search';
const COUNTRY_RE = /^[a-z]{2}$/i;

// `/lookup` is keyed by a fixed app id — the metadata behind it (name, icon,
// description) changes rarely, so a day-long cache is cheap to keep fresh.
// `/search` reflects live ranking and new releases, so it gets a shorter
// window: still enough to absorb repeat searches for the same term within a
// session, without the top results going stale for very long.
const LOOKUP_CACHE_TTL_SECONDS = 24 * 60 * 60;
const SEARCH_CACHE_TTL_SECONDS = 4 * 60 * 60;

/**
 * A server-side relay for two catalogue lookups the *landing page*
 * specifically needs — the promoted rail cards, the leaderboard's
 * self-promoted rows, and the "Feature your app here" dialog's live
 * search. Everywhere else in this project (`app.js`, `views/*.js`) still
 * calls Apple directly from the browser, unchanged — that's the "Nothing
 * uploaded. No account. No server." promise on the actual dashboard, and
 * it stays true there. The landing page never made that promise; it
 * already talks to this Worker for the community features, so relaying a
 * public, non-sensitive catalogue lookup through it too costs nothing.
 *
 * The reason this exists at all: Apple's endpoint is undocumented, and
 * whether it returns CORS headers for a direct browser request has
 * flip-flopped more than once during this project. A server-to-server
 * fetch has no CORS story to break — Apple's response headers only ever
 * matter to a *browser*, never to this Worker calling `fetch` itself.
 *
 * Two protections sit in front of that fetch, both earned the hard way:
 * these routes are unauthenticated by design (the landing page has no
 * sign-in), so nothing stops a script that isn't our frontend from calling
 * them directly at volume — unlike a browser, it isn't held back by CORS
 * either. A per-IP `ratelimits` binding (wrangler.jsonc) caps that, and a
 * Cache API read-through in front of the Apple fetch means many callers
 * asking about the same app or term within the TTL cost Apple nothing
 * beyond the first.
 */

/** Thrown by `fetchApple` so callers can turn a failure into a clean,
 * client-facing `error()` response with the right status — never a raw
 * 500, and never something a retry-happy client sees as cacheable. */
class UpstreamError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function fetchApple(url, subject) {
  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new UpstreamError(502, `Could not reach the App Store catalogue: ${err.message}`);
  }
  if (!response.ok) {
    throw new UpstreamError(502, `The App Store catalogue returned ${response.status} for "${subject}"`);
  }
  try {
    return await response.json();
  } catch {
    throw new UpstreamError(502, `The App Store catalogue returned an unreadable response for "${subject}"`);
  }
}

/** `key` is the client's IP — the only identity an unauthenticated route
 * has. Missing binding (e.g. a `wrangler dev` run without `--remote`) fails
 * open rather than breaking local development. */
async function withinLimit(env, bindingName, request) {
  const limiter = env[bindingName];
  if (!limiter) return true;
  const { success } = await limiter.limit({ key: request.headers.get('cf-connecting-ip') || 'unknown' });
  return success;
}

function tooManyRequests(env, request) {
  return json(
    env,
    request,
    { error: 'Too many requests to the App Store catalogue relay. Wait a minute and try again.' },
    { status: 429, headers: { 'retry-after': '60' } },
  );
}

/**
 * Cache-API read-through, keyed by a synthetic same-origin URL so identical
 * query params always hit the same cache entry regardless of the caller's
 * actual request headers. Only ever stores a *successful* payload — an
 * `UpstreamError` propagates past this function untouched, so a transient
 * 403 or 5xx from Apple is never what gets served to the next caller.
 */
async function cachedFetch(ctx, cacheKeyUrl, ttlSeconds, fetchOrigin) {
  const cache = caches.default;
  const cacheKey = new Request(cacheKeyUrl, { method: 'GET' });

  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();

  const payload = await fetchOrigin();

  const toCache = new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json', 'cache-control': `max-age=${ttlSeconds}` },
  });
  ctx.waitUntil(cache.put(cacheKey, toCache));

  return payload;
}

export async function lookup(request, env, ctx) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '';
  const country = COUNTRY_RE.test(url.searchParams.get('country') || '') ? url.searchParams.get('country') : 'us';

  if (!/^\d+$/.test(id)) return error(env, request, 400, 'id must be numeric');
  if (!(await withinLimit(env, 'ITUNES_LOOKUP_LIMITER', request))) return tooManyRequests(env, request);

  const cacheKeyUrl = `https://itunes-relay-cache.internal/lookup?id=${id}&country=${country.toLowerCase()}`;

  try {
    const payload = await cachedFetch(ctx, cacheKeyUrl, LOOKUP_CACHE_TTL_SECONDS, () =>
      fetchApple(`${LOOKUP_URL}?id=${encodeURIComponent(id)}&country=${country.toLowerCase()}`, id),
    );
    return json(env, request, payload);
  } catch (err) {
    if (!(err instanceof UpstreamError)) throw err;
    console.error('itunes lookup upstream failure', { id, country, status: err.status, message: err.message });
    return error(env, request, err.status, err.message);
  }
}

export async function search(request, env, ctx) {
  const url = new URL(request.url);
  const term = url.searchParams.get('term') || '';
  const country = COUNTRY_RE.test(url.searchParams.get('country') || '') ? url.searchParams.get('country') : 'us';
  const limitParam = Number(url.searchParams.get('limit'));
  const limit = Number.isInteger(limitParam) && limitParam > 0 && limitParam <= 200 ? limitParam : 50;

  if (!term.trim()) return error(env, request, 400, 'term is required');
  if (!(await withinLimit(env, 'ITUNES_SEARCH_LIMITER', request))) return tooManyRequests(env, request);

  const query = new URLSearchParams({
    term,
    country: country.toLowerCase(),
    entity: 'software',
    limit: String(limit),
  });
  const cacheKeyUrl = `https://itunes-relay-cache.internal/search?${query}`;

  try {
    const payload = await cachedFetch(ctx, cacheKeyUrl, SEARCH_CACHE_TTL_SECONDS, () =>
      fetchApple(`${SEARCH_URL}?${query}`, term),
    );
    return json(env, request, payload);
  } catch (err) {
    if (!(err instanceof UpstreamError)) throw err;
    console.error('itunes search upstream failure', { term, country, limit, status: err.status, message: err.message });
    return error(env, request, err.status, err.message);
  }
}
