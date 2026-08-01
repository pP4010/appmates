import { json, error } from '../lib/http.js';

const LOOKUP_URL = 'https://itunes.apple.com/lookup';
const SEARCH_URL = 'https://itunes.apple.com/search';
const COUNTRY_RE = /^[a-z]{2}$/i;

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
 */
export async function lookup(request, env) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '';
  const country = COUNTRY_RE.test(url.searchParams.get('country') || '') ? url.searchParams.get('country') : 'us';

  if (!/^\d+$/.test(id)) return error(env, request, 400, 'id must be numeric');

  let response;
  try {
    response = await fetch(`${LOOKUP_URL}?id=${encodeURIComponent(id)}&country=${country.toLowerCase()}`);
  } catch (err) {
    return error(env, request, 502, `Could not reach the App Store catalogue: ${err.message}`);
  }
  if (!response.ok) return error(env, request, 502, `The App Store catalogue returned ${response.status}`);

  let payload;
  try {
    payload = await response.json();
  } catch {
    return error(env, request, 502, 'The App Store catalogue returned an unreadable response');
  }
  return json(env, request, payload);
}

export async function search(request, env) {
  const url = new URL(request.url);
  const term = url.searchParams.get('term') || '';
  const country = COUNTRY_RE.test(url.searchParams.get('country') || '') ? url.searchParams.get('country') : 'us';
  const limitParam = Number(url.searchParams.get('limit'));
  const limit = Number.isInteger(limitParam) && limitParam > 0 && limitParam <= 200 ? limitParam : 50;

  if (!term.trim()) return error(env, request, 400, 'term is required');

  const query = new URLSearchParams({
    term,
    country: country.toLowerCase(),
    entity: 'software',
    limit: String(limit),
  });

  let response;
  try {
    response = await fetch(`${SEARCH_URL}?${query}`);
  } catch (err) {
    return error(env, request, 502, `Could not reach the App Store catalogue: ${err.message}`);
  }
  if (!response.ok) return error(env, request, 502, `The App Store catalogue returned ${response.status}`);

  let payload;
  try {
    payload = await response.json();
  } catch {
    return error(env, request, 502, 'The App Store catalogue returned an unreadable response');
  }
  return json(env, request, payload);
}
