import { json, error, newId } from '../lib/http.js';
import { currentUser } from '../lib/auth.js';
import { spendTokens, InsufficientTokensError } from '../lib/tokens.js';
import { isHttpUrl } from '../lib/validate.js';
import {
  FEATURE_COST_PER_DAY,
  MAX_FEATURE_DAYS,
  MAX_SLOTS_WANTED,
  MAX_DESCRIPTION_LENGTH,
} from '../lib/config.js';

const KINDS = new Set(['testing', 'launch']);
const PLATFORMS = new Set(['ios', 'android', 'both']);

function serializeListing(row) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    platform: row.platform,
    link: row.link,
    description: row.description,
    slotsWanted: row.slots_wanted,
    slotsFilled: row.slots_filled ?? 0,
    featuredUntil: row.featured_until,
    createdAt: row.created_at,
    app: {
      id: row.app_id,
      trackId: row.track_id,
      name: row.name,
      artworkUrl: row.artwork_url,
      storeUrl: row.store_url,
    },
  };
}

const LISTING_JOIN_SELECT = `
  SELECT l.*, a.track_id, a.name, a.artwork_url, a.store_url,
    (SELECT COUNT(*) FROM test_sessions ts
       WHERE ts.listing_id = l.id AND ts.status != 'abandoned') AS slots_filled
  FROM listings l JOIN apps a ON a.id = l.app_id
`;

export async function create(request, env) {
  const user = await currentUser(env, request);
  if (!user) return error(env, request, 401, 'sign in required');

  let body;
  try {
    body = await request.json();
  } catch {
    return error(env, request, 400, 'expected JSON body');
  }

  const kind = body?.kind;
  const platform = body?.platform;
  const link = String(body?.link ?? '').trim();
  const description = String(body?.description ?? '').trim().slice(0, MAX_DESCRIPTION_LENGTH);
  const slotsWanted = Number.isInteger(body?.slotsWanted) ? body.slotsWanted : 0;

  if (!KINDS.has(kind)) return error(env, request, 400, 'kind must be "testing" or "launch"');
  if (!PLATFORMS.has(platform)) {
    return error(env, request, 400, 'platform must be "ios", "android", or "both"');
  }
  if (!isHttpUrl(link)) return error(env, request, 400, 'link must be a valid http(s) URL');
  if (slotsWanted < 0 || slotsWanted > MAX_SLOTS_WANTED) {
    return error(env, request, 400, `slotsWanted must be between 0 and ${MAX_SLOTS_WANTED}`);
  }

  const app = await env.DB.prepare('SELECT * FROM apps WHERE id = ? AND owner_user_id = ?')
    .bind(body?.appId, user.id)
    .first();
  if (!app) return error(env, request, 404, 'app not found');

  const id = newId();
  await env.DB.prepare(
    'INSERT INTO listings (id, app_id, owner_user_id, kind, platform, link, description, slots_wanted) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, app.id, user.id, kind, platform, link, description, slotsWanted)
    .run();

  const row = await env.DB.prepare(LISTING_JOIN_SELECT + ' WHERE l.id = ?').bind(id).first();
  return json(env, request, { listing: serializeListing(row) }, { status: 201 });
}

/** Featured listings first (while `featured_until` is still in the future),
 * then newest first. No public metric here is influenced by anything but
 * the developer's own token spend and their listing's creation time. */
export async function browse(request, env) {
  const url = new URL(request.url);
  const kind = url.searchParams.get('kind');
  const conditions = ["l.status = 'open'"];
  const params = [];
  if (KINDS.has(kind)) {
    conditions.push('l.kind = ?');
    params.push(kind);
  }

  const { results } = await env.DB.prepare(
    `${LISTING_JOIN_SELECT} WHERE ${conditions.join(' AND ')} ` +
      "ORDER BY (l.featured_until IS NOT NULL AND l.featured_until > datetime('now')) DESC, " +
      'l.created_at DESC LIMIT 100',
  )
    .bind(...params)
    .all();

  return json(env, request, { listings: results.map(serializeListing) });
}

export async function mine(request, env) {
  const user = await currentUser(env, request);
  if (!user) return error(env, request, 401, 'sign in required');

  const { results } = await env.DB.prepare(
    `${LISTING_JOIN_SELECT} WHERE l.owner_user_id = ? ORDER BY l.created_at DESC`,
  )
    .bind(user.id)
    .all();
  return json(env, request, { listings: results.map(serializeListing) });
}

async function ownedListing(env, id, userId) {
  return env.DB.prepare('SELECT * FROM listings WHERE id = ? AND owner_user_id = ?')
    .bind(id, userId)
    .first();
}

export async function close(request, env, id) {
  const user = await currentUser(env, request);
  if (!user) return error(env, request, 401, 'sign in required');

  const listing = await ownedListing(env, id, user.id);
  if (!listing) return error(env, request, 404, 'listing not found');

  await env.DB.prepare('UPDATE listings SET status = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .bind('closed', id)
    .run();
  return json(env, request, { ok: true });
}

/** The testers who joined, for the listing's owner to review feedback and
 * mark sessions complete — the only way a tester's token gets minted. */
export async function sessionsFor(request, env, id) {
  const user = await currentUser(env, request);
  if (!user) return error(env, request, 401, 'sign in required');

  const listing = await ownedListing(env, id, user.id);
  if (!listing) return error(env, request, 404, 'listing not found');

  const { results } = await env.DB.prepare(
    `SELECT ts.id, ts.status, ts.feedback, ts.created_at, ts.submitted_at, ts.completed_at,
            u.email AS tester_email
     FROM test_sessions ts JOIN users u ON u.id = ts.tester_user_id
     WHERE ts.listing_id = ? ORDER BY ts.created_at DESC`,
  )
    .bind(id)
    .all();

  return json(env, request, {
    sessions: results.map((r) => ({
      id: r.id,
      status: r.status,
      feedback: r.feedback,
      testerEmail: r.tester_email,
      createdAt: r.created_at,
      submittedAt: r.submitted_at,
      completedAt: r.completed_at,
    })),
  });
}

/** Spends tokens to push a listing to the top of `browse` for N days. Cost
 * and cap are fixed platform constants, never client-supplied, so the
 * economy can't be gamed by sending an arbitrary price. */
export async function feature(request, env, id) {
  const user = await currentUser(env, request);
  if (!user) return error(env, request, 401, 'sign in required');

  const listing = await ownedListing(env, id, user.id);
  if (!listing) return error(env, request, 404, 'listing not found');

  let body;
  try {
    body = await request.json();
  } catch {
    return error(env, request, 400, 'expected JSON body');
  }
  const days = Number.isInteger(body?.days) ? body.days : 0;
  if (days < 1 || days > MAX_FEATURE_DAYS) {
    return error(env, request, 400, `days must be between 1 and ${MAX_FEATURE_DAYS}`);
  }

  const cost = days * FEATURE_COST_PER_DAY;
  try {
    await spendTokens(env, user.id, cost, 'spent_feature', id);
  } catch (err) {
    if (err instanceof InsufficientTokensError) {
      return error(env, request, 402, `not enough tokens — this costs ${cost}`);
    }
    throw err;
  }

  // Extends from the current `featured_until` if it's still in the future,
  // otherwise from now — computed entirely in SQL (see the note on
  // `isRateLimited` in lib/auth.js for why: comparing a JS-formatted
  // timestamp against SQLite's own `datetime('now')` as text silently
  // never matches).
  await env.DB.prepare(
    `UPDATE listings SET
       featured_until = datetime(
         CASE WHEN featured_until IS NOT NULL AND featured_until > datetime('now')
              THEN featured_until ELSE datetime('now') END,
         ?
       ),
       updated_at = datetime('now')
     WHERE id = ?`,
  )
    .bind(`+${days} days`, id)
    .run();

  const updated = await env.DB.prepare('SELECT featured_until FROM listings WHERE id = ?')
    .bind(id)
    .first();

  return json(env, request, { ok: true, featuredUntil: updated.featured_until, spent: cost });
}

/** A tester claims a slot. Can't be the listing's own owner, can't join a
 * closed listing, and the DB's UNIQUE(listing_id, tester_user_id) makes a
 * second join from the same tester a clean 409 rather than a duplicate row. */
export async function join(request, env, id) {
  const user = await currentUser(env, request);
  if (!user) return error(env, request, 401, 'sign in required');

  const listing = await env.DB.prepare('SELECT * FROM listings WHERE id = ?').bind(id).first();
  if (!listing || listing.status !== 'open') return error(env, request, 404, 'listing not found');
  if (listing.owner_user_id === user.id) {
    return error(env, request, 400, "you can't join your own listing");
  }

  const sessionId = newId();
  try {
    await env.DB.prepare(
      'INSERT INTO test_sessions (id, listing_id, tester_user_id) VALUES (?, ?, ?)',
    )
      .bind(sessionId, id, user.id)
      .run();
  } catch {
    return error(env, request, 409, 'you already joined this listing');
  }

  return json(env, request, { ok: true, sessionId }, { status: 201 });
}
