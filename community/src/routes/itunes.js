import { publicJson as json, publicError as error } from '../lib/http.js';

const LOOKUP_URL = 'https://itunes.apple.com/lookup';
const SEARCH_URL = 'https://itunes.apple.com/search';
const COUNTRY_RE = /^[a-z]{2}$/i;

// `/lookup` is keyed by a fixed app id — the metadata behind it (name, icon,
// description) changes rarely, so it is refreshed once a day but kept around
// (and served stale) for a month past that if Apple can't be reached, rather
// than turning a transient upstream hiccup into a name-only card on every
// landing page using this relay. `/search` reflects live ranking and new
// releases, so both windows are tighter: still enough to absorb repeat
// searches for the same term, without a stale top-10 sticking around long
// after Apple recovers.
const LOOKUP_SOFT_TTL_SECONDS = 24 * 60 * 60;
const LOOKUP_HARD_TTL_SECONDS = 30 * 24 * 60 * 60;
const SEARCH_SOFT_TTL_SECONDS = 4 * 60 * 60;
const SEARCH_HARD_TTL_SECONDS = 24 * 60 * 60;

/**
 * A server-side relay for catalogue lookups, used by every `ITunesClient` in
 * this project once `community/` is deployed (see `itunesRelayOptions()` in
 * `web/lib/community.js`, wired into both `app.js` and `landing.js`) — the
 * dashboard's own search and overview, the promoted rail cards, the
 * leaderboard's self-promoted rows, and the "Feature your app here" dialog's
 * live search all go through here. A fresh clone with no `community/`
 * backend deployed falls back to `ITunesClient`'s own defaults and calls
 * Apple directly from the browser instead — that's what keeps the "Nothing
 * uploaded. No account. No server." promise true for that deployment shape.
 *
 * `/lookup` must accept both ways `ITunesClient.lookup` identifies an app —
 * a numeric `id` or a `bundleId` (e.g. `com.paolo.kaizen`) — since callers
 * choose between the two based on what the user typed in, not on whether a
 * relay is in the way.
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

function tooManyRequests(request) {
  return json(
    request,
    { error: 'Too many requests to the App Store catalogue relay. Wait a minute and try again.' },
    { status: 429, headers: { 'retry-after': '60' } },
  );
}

/**
 * Cache-API read-through, keyed by a synthetic same-origin URL so identical
 * query params always hit the same cache entry regardless of the caller's
 * actual request headers.
 *
 * `softTtlSeconds` is when a cached answer is refreshed; `hardTtlSeconds` is
 * how long it is still served if that refresh fails. The stored entry's own
 * age is tracked separately from `Cache-Control`, which is set to the *hard*
 * TTL — otherwise the Cache API would evict the entry at the soft TTL and
 * there would be nothing left to fall back to right when a fallback is
 * needed most. Only a successful `fetchOrigin()` ever updates the entry, so
 * a transient 403 or 5xx from Apple never overwrites a good cached payload
 * with nothing — it just leaves the existing one to keep serving.
 */
async function cachedFetch(ctx, cacheKeyUrl, softTtlSeconds, hardTtlSeconds, fetchOrigin) {
  const cache = caches.default;
  const cacheKey = new Request(cacheKeyUrl, { method: 'GET' });

  const hit = await cache.match(cacheKey);
  const entry = hit ? await hit.json() : null;
  const ageSeconds = entry ? (Date.now() - entry.storedAt) / 1000 : Infinity;

  if (entry && ageSeconds < softTtlSeconds) return entry.payload;

  try {
    const payload = await fetchOrigin();
    const toCache = new Response(JSON.stringify({ storedAt: Date.now(), payload }), {
      headers: { 'content-type': 'application/json', 'cache-control': `max-age=${hardTtlSeconds}` },
    });
    ctx.waitUntil(cache.put(cacheKey, toCache));
    return payload;
  } catch (err) {
    // Apple is unreachable or erroring right now. An entry that has aged
    // past its soft TTL but not its hard one is still a far better answer
    // than an upstream error surfacing as a name-only card on every site
    // using this relay, for data that rarely changes to begin with.
    if (entry && ageSeconds < hardTtlSeconds) return entry.payload;
    throw err;
  }
}

export async function lookup(request, env, ctx) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '';
  const bundleId = url.searchParams.get('bundleId') || '';
  const country = COUNTRY_RE.test(url.searchParams.get('country') || '') ? url.searchParams.get('country') : 'us';

  // Mirrors `ITunesClient.lookup` on the client (web/lib/itunes.js): a
  // numeric `id` and a `bundleId` (e.g. `com.paolo.kaizen`) are both valid
  // ways to identify an app, and the caller sends exactly one of them.
  let subject;
  let appleQuery;
  if (/^\d+$/.test(id)) {
    subject = id;
    appleQuery = `id=${encodeURIComponent(id)}`;
  } else if (bundleId) {
    subject = bundleId;
    appleQuery = `bundleId=${encodeURIComponent(bundleId)}`;
  } else {
    return error(request, 400, 'id must be numeric, or bundleId must be provided');
  }

  if (!(await withinLimit(env, 'ITUNES_LOOKUP_LIMITER', request))) return tooManyRequests(request);

  const cacheKeyUrl = `https://itunes-relay-cache.internal/lookup?${appleQuery}&country=${country.toLowerCase()}`;

  try {
    const payload = await cachedFetch(ctx, cacheKeyUrl, LOOKUP_SOFT_TTL_SECONDS, LOOKUP_HARD_TTL_SECONDS, () =>
      fetchApple(`${LOOKUP_URL}?${appleQuery}&country=${country.toLowerCase()}`, subject),
    );
    return json(request, payload);
  } catch (err) {
    if (!(err instanceof UpstreamError)) throw err;
    console.error('itunes lookup upstream failure', { subject, country, status: err.status, message: err.message });
    return error(request, err.status, err.message);
  }
}

export async function search(request, env, ctx) {
  const url = new URL(request.url);
  const term = url.searchParams.get('term') || '';
  const country = COUNTRY_RE.test(url.searchParams.get('country') || '') ? url.searchParams.get('country') : 'us';
  const limitParam = Number(url.searchParams.get('limit'));
  const limit = Number.isInteger(limitParam) && limitParam > 0 && limitParam <= 200 ? limitParam : 50;

  if (!term.trim()) return error(request, 400, 'term is required');
  if (!(await withinLimit(env, 'ITUNES_SEARCH_LIMITER', request))) return tooManyRequests(request);

  const query = new URLSearchParams({
    term,
    country: country.toLowerCase(),
    entity: 'software',
    limit: String(limit),
  });
  const cacheKeyUrl = `https://itunes-relay-cache.internal/search?${query}`;

  try {
    const payload = await cachedFetch(ctx, cacheKeyUrl, SEARCH_SOFT_TTL_SECONDS, SEARCH_HARD_TTL_SECONDS, () =>
      fetchApple(`${SEARCH_URL}?${query}`, term),
    );
    return json(request, payload);
  } catch (err) {
    if (!(err instanceof UpstreamError)) throw err;
    console.error('itunes search upstream failure', { term, country, limit, status: err.status, message: err.message });
    return error(request, err.status, err.message);
  }
}
