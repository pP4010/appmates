/** Small shared HTTP helpers: CORS, JSON responses, cookies.
 *
 * CORS here is deliberately narrower than the screenshot relay's — these
 * requests carry an auth cookie, so the origin is locked to exactly
 * `env.APP_ORIGIN` rather than `*`, and credentials are explicitly allowed.
 */

export function corsHeaders(env, request) {
  const origin = request.headers.get('origin');
  const allowed = origin === env.APP_ORIGIN ? origin : env.APP_ORIGIN;
  return {
    'access-control-allow-origin': allowed,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'origin',
  };
}

export function json(env, request, body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...corsHeaders(env, request),
      ...init.headers,
    },
  });
}

export function error(env, request, status, message) {
  return json(env, request, { error: message }, { status });
}

/**
 * Wide-open CORS for the handful of routes that carry no session cookie and
 * serve data that is public regardless of who asks (App Store catalogue
 * lookups, approved promo slots) — unlike `corsHeaders`, this doesn't
 * require `APP_ORIGIN` to exactly match wherever the landing page happens to
 * be deployed. That match is easy to get wrong or leave stale, and the
 * failure is silent: a browser CORS block on one of these routes doesn't
 * throw an error a visitor (or a log) would surface, it just makes the
 * requested data quietly not appear.
 */
export function publicJson(request, body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      ...init.headers,
    },
  });
}

export function publicError(request, status, message) {
  return publicJson(request, { error: message }, { status });
}

const SESSION_COOKIE = 'lp_session';

export function readSessionToken(request) {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === SESSION_COOKIE) return rest.join('=');
  }
  return null;
}

/** `Secure` is only added over https — plain-http local dev would silently
 * drop the cookie otherwise, since browsers refuse to store a `Secure`
 * cookie from an insecure origin. */
export function sessionCookieHeader(request, token, { maxAgeSeconds } = {}) {
  const isHttps = new URL(request.url).protocol === 'https:';
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=None',
    ...(isHttps ? ['Secure'] : []),
    ...(maxAgeSeconds != null ? [`Max-Age=${maxAgeSeconds}`] : ['Max-Age=0']),
  ];
  return parts.join('; ');
}

export function newId() {
  return crypto.randomUUID();
}

/** True if this request is still within its per-IP budget for `bindingName`
 * (one of the `ratelimits` bindings in wrangler.jsonc) — `false` once it's
 * spent. Missing binding (e.g. a `wrangler dev` run without `--remote`)
 * fails open rather than breaking local development. Originally local to
 * routes/itunes.js (the only unauthenticated route when it was written);
 * shared here once `listings.create`/`listings.request` needed the same
 * per-IP cap — a session gates *who* can call those, not *how often*, and
 * `request` in particular accepts a caller with no session at all. */
export async function withinLimit(env, bindingName, request) {
  const limiter = env[bindingName];
  if (!limiter) return true;
  const { success } = await limiter.limit({ key: request.headers.get('cf-connecting-ip') || 'unknown' });
  return success;
}
