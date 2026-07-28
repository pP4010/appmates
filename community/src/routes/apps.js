import { json, error, newId } from '../lib/http.js';
import { currentUser } from '../lib/auth.js';
import { isHttpUrl } from '../lib/validate.js';

const COUNTRY_RE = /^[a-z]{2}$/;

function serializeApp(row) {
  return {
    id: row.id,
    trackId: row.track_id,
    bundleId: row.bundle_id,
    name: row.name,
    artworkUrl: row.artwork_url,
    storeUrl: row.store_url,
    country: row.country,
    createdAt: row.created_at,
  };
}

/**
 * Connects an app to the signed-in user. `trackId` is the only fact that
 * has to be right — everything else here is display data Overview already
 * fetched from the public catalogue, so this never asks a developer to
 * retype anything, and it upserts rather than duplicating on repeat calls.
 */
export async function create(request, env) {
  const user = await currentUser(env, request);
  if (!user) return error(env, request, 401, 'sign in required');

  let body;
  try {
    body = await request.json();
  } catch {
    return error(env, request, 400, 'expected JSON body');
  }

  const trackId = String(body?.trackId ?? '').trim();
  const name = String(body?.name ?? '').trim();
  if (!/^\d+$/.test(trackId)) return error(env, request, 400, 'trackId must be numeric');
  if (!name) return error(env, request, 400, 'name is required');

  const bundleId = body?.bundleId ? String(body.bundleId).slice(0, 200) : null;
  // Not rendered as a link anywhere today, but validated the same as a
  // listing's link regardless — a field that is safe now and unsafe the
  // moment someone adds a feature that renders it is not actually safe.
  const rawArtwork = body?.artworkUrl ? String(body.artworkUrl).slice(0, 1000) : null;
  const rawStoreUrl = body?.storeUrl ? String(body.storeUrl).slice(0, 1000) : null;
  if (rawArtwork && !isHttpUrl(rawArtwork)) {
    return error(env, request, 400, 'artworkUrl must be a valid http(s) URL');
  }
  if (rawStoreUrl && !isHttpUrl(rawStoreUrl)) {
    return error(env, request, 400, 'storeUrl must be a valid http(s) URL');
  }
  const artworkUrl = rawArtwork;
  const storeUrl = rawStoreUrl;
  const country = COUNTRY_RE.test(body?.country) ? body.country.toLowerCase() : 'us';

  const existing = await env.DB.prepare(
    'SELECT * FROM apps WHERE owner_user_id = ? AND track_id = ?',
  )
    .bind(user.id, trackId)
    .first();

  if (existing) {
    await env.DB.prepare(
      'UPDATE apps SET name = ?, bundle_id = ?, artwork_url = ?, store_url = ?, country = ? WHERE id = ?',
    )
      .bind(name, bundleId, artworkUrl, storeUrl, country, existing.id)
      .run();
    return json(env, request, {
      app: serializeApp({ ...existing, name, bundle_id: bundleId, artwork_url: artworkUrl, store_url: storeUrl, country }),
    });
  }

  const id = newId();
  await env.DB.prepare(
    'INSERT INTO apps (id, owner_user_id, track_id, bundle_id, name, artwork_url, store_url, country) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, user.id, trackId, bundleId, name, artworkUrl, storeUrl, country)
    .run();

  const row = await env.DB.prepare('SELECT * FROM apps WHERE id = ?').bind(id).first();
  return json(env, request, { app: serializeApp(row) }, { status: 201 });
}

export async function mine(request, env) {
  const user = await currentUser(env, request);
  if (!user) return error(env, request, 401, 'sign in required');

  const { results } = await env.DB.prepare(
    'SELECT * FROM apps WHERE owner_user_id = ? ORDER BY created_at DESC',
  )
    .bind(user.id)
    .all();
  return json(env, request, { apps: results.map(serializeApp) });
}
