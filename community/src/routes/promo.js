import { json, error, newId } from '../lib/http.js';
import { currentUser, isValidEmail, isAdmin } from '../lib/auth.js';
import { isValidMessage } from '../lib/validate.js';
import {
  PROMO_COLORS,
  MIN_PROMO_MESSAGE_LENGTH,
  MAX_PROMO_MESSAGE_LENGTH,
  MAX_NAME_LENGTH,
} from '../lib/config.js';

function serialize(row) {
  return {
    id: row.id,
    requesterName: row.requester_name,
    requesterEmail: row.requester_email,
    trackId: row.track_id,
    appName: row.app_name,
    appGenre: row.app_genre,
    artworkUrl: row.artwork_url,
    storeUrl: row.store_url,
    color: row.color,
    message: row.message,
    status: row.status,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  };
}

/**
 * Submits a request for a promoted sidebar slot — the landing page's
 * "Feature your app here" dialog. Reviewed by hand (`adminList`/
 * `adminReview`), never auto-published: this is what the dialog's own
 * pricing note promises when it says nothing is ever charged without
 * confirmation.
 *
 * No sign-in wall. This is a business inquiry, not a marketplace action, so
 * it only needs a name and an email to reply to — the same bar a tester's
 * anonymous first contact clears in `listings.request`.
 */
export async function create(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return error(env, request, 400, 'expected JSON body');
  }

  const requesterName = String(body?.requesterName ?? '').trim().slice(0, MAX_NAME_LENGTH);
  const requesterEmail = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const trackId = String(body?.trackId ?? '').trim();
  const appName = String(body?.appName ?? '').trim();
  const appGenre = body?.appGenre ? String(body.appGenre).slice(0, 200) : null;
  const artworkUrl = body?.artworkUrl ? String(body.artworkUrl).slice(0, 1000) : null;
  const storeUrl = body?.storeUrl ? String(body.storeUrl).slice(0, 1000) : null;
  const color = String(body?.color ?? '');
  const message = String(body?.message ?? '');

  if (!requesterName) return error(env, request, 400, 'name is required');
  if (!isValidEmail(requesterEmail)) return error(env, request, 400, 'a valid email is required');
  if (!/^\d+$/.test(trackId)) return error(env, request, 400, 'trackId must be numeric');
  if (!appName) return error(env, request, 400, 'appName is required');
  if (!PROMO_COLORS.includes(color)) {
    return error(env, request, 400, `color must be one of: ${PROMO_COLORS.join(', ')}`);
  }
  if (!isValidMessage(message, { min: MIN_PROMO_MESSAGE_LENGTH, max: MAX_PROMO_MESSAGE_LENGTH })) {
    return error(
      env,
      request,
      400,
      `message must be at least ${MIN_PROMO_MESSAGE_LENGTH} characters — say what the app does and why you'd like a slot`,
    );
  }

  const id = newId();
  await env.DB.prepare(
    `INSERT INTO promo_requests
     (id, requester_name, requester_email, track_id, app_name, app_genre, artwork_url, store_url, color, message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, requesterName, requesterEmail, trackId, appName, appGenre, artworkUrl, storeUrl, color, message.trim())
    .run();

  const row = await env.DB.prepare('SELECT * FROM promo_requests WHERE id = ?').bind(id).first();
  return json(env, request, { request: serialize(row) }, { status: 201 });
}

/** Every request, newest first within each bucket — pending ones need
 * attention, but approved and rejected stay visible too, so the inbox reads
 * as a full history rather than a queue that erases itself once cleared. */
export async function adminList(request, env) {
  const user = await currentUser(env, request);
  if (!isAdmin(env, user)) return error(env, request, 403, 'admin access required');

  const { results } = await env.DB.prepare(
    `SELECT * FROM promo_requests ORDER BY (status = 'pending') DESC, created_at DESC`,
  ).all();
  return json(env, request, { requests: results.map(serialize) });
}

/** Approve or reject a request. `featured` (below) is what a landing page
 * actually reads, so this is the entire act of "going live" — nothing else
 * to run, no redeploy needed. */
export async function adminReview(request, env, id, action) {
  const user = await currentUser(env, request);
  if (!isAdmin(env, user)) return error(env, request, 403, 'admin access required');
  if (action !== 'approve' && action !== 'reject') return error(env, request, 400, 'unknown action');

  const existing = await env.DB.prepare('SELECT * FROM promo_requests WHERE id = ?').bind(id).first();
  if (!existing) return error(env, request, 404, 'request not found');
  if (existing.status !== 'pending') {
    return error(env, request, 400, `already ${existing.status}`);
  }

  const status = action === 'approve' ? 'approved' : 'rejected';
  await env.DB.prepare("UPDATE promo_requests SET status = ?, reviewed_at = datetime('now') WHERE id = ?")
    .bind(status, id)
    .run();

  const row = await env.DB.prepare('SELECT * FROM promo_requests WHERE id = ?').bind(id).first();
  return json(env, request, { request: serialize(row) });
}

/**
 * Public, no auth: the approved requests a landing page renders as
 * promoted rail cards. Shaped exactly like `RAIL_LEFT`/`RAIL_RIGHT` in
 * `web/landing-demo.js` (`trackId`/`name`/`color`/`country`) so
 * `renderRails` in `web/landing.js` can merge these in directly.
 */
export async function featured(request, env) {
  const { results } = await env.DB.prepare(
    `SELECT track_id, app_name, color FROM promo_requests
     WHERE status = 'approved' ORDER BY reviewed_at DESC LIMIT 20`,
  ).all();
  return json(env, request, {
    slots: results.map((r) => ({ trackId: r.track_id, name: r.app_name, color: r.color, country: 'us' })),
  });
}
