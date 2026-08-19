import { json, error, newId } from '../lib/http.js';
import { currentUser, isValidEmail, issueMagicLink, sendMagicLinkEmail, getOrCreateUser } from '../lib/auth.js';
import { spendTokens, InsufficientTokensError } from '../lib/tokens.js';
import { isHttpUrl, isValidMessage } from '../lib/validate.js';
import { builderReliability } from '../lib/reputation.js';
import {
  FEATURE_COST_PER_DAY,
  MAX_FEATURE_DAYS,
  MAX_SLOTS_WANTED,
  MAX_DESCRIPTION_LENGTH,
  MIN_REQUEST_MESSAGE_LENGTH,
  MAX_REQUEST_MESSAGE_LENGTH,
  MAX_NAME_LENGTH,
  TOKEN_TIER_BRONZE,
  TOKEN_TIER_SILVER,
  TOKEN_TIER_GOLD,
} from '../lib/config.js';

const KINDS = new Set(['testing', 'launch']);
const PLATFORMS = new Set(['ios', 'android', 'both']);

/** 0–3, purely cosmetic (see the comment on `TOKEN_TIER_BRONZE` in
 * lib/config.js) — never fed into `ORDER BY`. */
function ownerBoostTier(row) {
  const balance = row.owner_token_balance ?? 0;
  // This row is the owner's one and only listing, ever, and they haven't
  // earned a token yet — the exact shape of someone who just signed up.
  // Free bronze so their first post isn't the only flat card on the page.
  if (row.owner_listing_count === 1 && balance === 0) return 1;
  if (balance >= TOKEN_TIER_GOLD) return 3;
  if (balance >= TOKEN_TIER_SILVER) return 2;
  if (balance >= TOKEN_TIER_BRONZE) return 1;
  return 0;
}

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
      // Carried so a client can re-derive this app's public catalogue facts
      // from the same storefront the owner connected it on.
      country: row.country,
    },
    ownerReliability: builderReliability({
      completedCount: row.owner_completed_count ?? 0,
      resolvedCount: row.owner_resolved_count ?? 0,
      avgResponseHours: row.owner_avg_response_hours,
    }),
    // How much this listing's owner has given back by testing *other*
    // people's apps. Only a third party confirming their work can move it,
    // so it can't be inflated from your own account — see `complete` in
    // routes/testSessions.js.
    ownerContribution: row.owner_contribution_count ?? 0,
    // Cosmetic only — see `ownerBoostTier` above. Never used for sorting.
    ownerBoostTier: ownerBoostTier(row),
  };
}

// A slot only counts as filled once a builder has actually accepted someone
// into it — a pile of unreviewed `requested` rows isn't capacity used, it's
// capacity being asked for. Reliability is computed across every listing the
// same owner has ever posted, not just this one, so a brand-new listing from
// a proven builder still shows their track record.
const LISTING_SELECT = `
  SELECT l.*, a.track_id, a.name, a.artwork_url, a.store_url, a.country,
    (SELECT COUNT(*) FROM test_sessions ts
       WHERE ts.listing_id = l.id AND ts.status IN ('accepted', 'submitted', 'completed')
    ) AS slots_filled,
    (SELECT COUNT(*) FROM test_sessions ts2 JOIN listings l2 ON l2.id = ts2.listing_id
       WHERE l2.owner_user_id = l.owner_user_id AND ts2.status = 'completed'
    ) AS owner_completed_count,
    (SELECT COUNT(*) FROM test_sessions ts3 JOIN listings l3 ON l3.id = ts3.listing_id
       WHERE l3.owner_user_id = l.owner_user_id AND ts3.status IN ('completed', 'declined', 'abandoned')
    ) AS owner_resolved_count,
    (SELECT AVG((julianday(ts4.responded_at) - julianday(ts4.created_at)) * 24)
       FROM test_sessions ts4 JOIN listings l4 ON l4.id = ts4.listing_id
       WHERE l4.owner_user_id = l.owner_user_id AND ts4.responded_at IS NOT NULL
    ) AS owner_avg_response_hours,
    (SELECT COUNT(*) FROM test_sessions ts5
       WHERE ts5.tester_user_id = l.owner_user_id AND ts5.status = 'completed'
    ) AS owner_contribution_count,
    u.token_balance AS owner_token_balance,
    (SELECT COUNT(*) FROM listings l6 WHERE l6.owner_user_id = l.owner_user_id) AS owner_listing_count
  FROM listings l JOIN apps a ON a.id = l.app_id JOIN users u ON u.id = l.owner_user_id
`;

// Safelisted so a sort value can never reach the SQL string as user input.
// `newest` stays the default deliberately: ordering the main list by
// contribution would bury every first-time listing under the same regulars,
// and the contributor showcase (routes/leaderboard.js) already rewards
// giving back without costing newcomers their only shot at being seen.
const SORTS = {
  newest: 'l.created_at DESC',
  contributors: 'owner_contribution_count DESC, l.created_at DESC',
  emptiest: 'slots_filled ASC, l.created_at DESC',
};

/** Maps a client-supplied sort name to a fixed SQL fragment, falling back to
 * the default for anything unrecognised. The lookup is the whole security
 * property: no caller-controlled string ever reaches the query text.
 *
 * The `typeof` guard is not redundant — a property key is coerced with
 * `toString()`, so without it an array like `['contributors']` would match
 * the entry it stringifies to. `searchParams.get()` only ever hands back a
 * string or null today, but this function should not depend on its one
 * caller staying that way. */
export function resolveSort(sort) {
  if (typeof sort !== 'string') return SORTS.newest;
  return Object.hasOwn(SORTS, sort) ? SORTS[sort] : SORTS.newest;
}

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

  const row = await env.DB.prepare(LISTING_SELECT + ' WHERE l.id = ?').bind(id).first();
  return json(env, request, { listing: serializeListing(row) }, { status: 201 });
}

/** Featured listings first (while `featured_until` is still in the future),
 * then whichever `sort` the caller asked for. The only thing that can lift a
 * listing above the chosen sort is the owner's own token spend — and tokens
 * are earned by testing, never bought, so paid placement has no route in. */
export async function browse(request, env) {
  const url = new URL(request.url);
  const kind = url.searchParams.get('kind');
  const orderBy = resolveSort(url.searchParams.get('sort'));

  const conditions = ["l.status = 'open'"];
  const params = [];
  if (KINDS.has(kind)) {
    conditions.push('l.kind = ?');
    params.push(kind);
  }

  const { results } = await env.DB.prepare(
    `${LISTING_SELECT} WHERE ${conditions.join(' AND ')} ` +
      "ORDER BY (l.featured_until IS NOT NULL AND l.featured_until > datetime('now')) DESC, " +
      `${orderBy} LIMIT 100`,
  )
    .bind(...params)
    .all();

  return json(env, request, { listings: results.map(serializeListing) });
}

export async function mine(request, env) {
  const user = await currentUser(env, request);
  if (!user) return error(env, request, 401, 'sign in required');

  const { results } = await env.DB.prepare(
    `${LISTING_SELECT} WHERE l.owner_user_id = ? ORDER BY l.created_at DESC`,
  )
    .bind(user.id)
    .all();
  return json(env, request, { listings: results.map(serializeListing) });
}

/** The public detail page for one listing — the equivalent of a single
 * startup's page on TrustMRR. No auth: browsing a listing needs no account,
 * only requesting a spot on it does. */
export async function detail(request, env, id) {
  const row = await env.DB.prepare(`${LISTING_SELECT} WHERE l.id = ?`).bind(id).first();
  if (!row) return error(env, request, 404, 'listing not found');
  return json(env, request, { listing: serializeListing(row) });
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

/** Every request against this listing, for the owner: pending ones to
 * review (`requested`) and the ones already moving through the funnel. The
 * UI splits these into two lists client-side rather than two endpoints. */
export async function sessionsFor(request, env, id) {
  const user = await currentUser(env, request);
  if (!user) return error(env, request, 401, 'sign in required');

  const listing = await ownedListing(env, id, user.id);
  if (!listing) return error(env, request, 404, 'listing not found');

  const { results } = await env.DB.prepare(
    `SELECT ts.id, ts.status, ts.request_message, ts.feedback, ts.bug_found, ts.would_use_again,
            ts.created_at, ts.responded_at, ts.submitted_at, ts.completed_at,
            u.email AS tester_email, u.display_name AS tester_display_name,
            (SELECT COUNT(*) FROM test_sessions t2
               WHERE t2.tester_user_id = u.id AND t2.status = 'completed') AS tester_completed_count
     FROM test_sessions ts JOIN users u ON u.id = ts.tester_user_id
     WHERE ts.listing_id = ? ORDER BY ts.created_at DESC`,
  )
    .bind(id)
    .all();

  return json(env, request, {
    sessions: results.map((r) => ({
      id: r.id,
      status: r.status,
      requestMessage: r.request_message,
      feedback: r.feedback,
      bugFound: r.bug_found === null ? null : Boolean(r.bug_found),
      wouldUseAgain: r.would_use_again,
      testerEmail: r.tester_email,
      testerDisplayName: r.tester_display_name,
      testerCompletedCount: r.tester_completed_count,
      createdAt: r.created_at,
      respondedAt: r.responded_at,
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
    // Extends from the current `featured_until` if it's still in the future,
    // otherwise from now — computed entirely in SQL (see the note on
    // `isRateLimited` in lib/auth.js for why: comparing a JS-formatted
    // timestamp against SQLite's own `datetime('now')` as text silently
    // never matches). This rides in the same D1 batch as the spend (see
    // `spendTokens`/`applyDelta` in lib/tokens.js): tokens deducted with the
    // listing never actually featured, and no way to retry once they're
    // gone, was a real failure mode when these were two separate calls.
    await spendTokens(env, user.id, cost, 'spent_feature', id, [
      env.DB.prepare(
        `UPDATE listings SET
           featured_until = datetime(
             CASE WHEN featured_until IS NOT NULL AND featured_until > datetime('now')
                  THEN featured_until ELSE datetime('now') END,
             ?
           ),
           updated_at = datetime('now')
         WHERE id = ?`,
      ).bind(`+${days} days`, id),
    ]);
  } catch (err) {
    if (err instanceof InsufficientTokensError) {
      return error(env, request, 402, `not enough tokens — this costs ${cost}`);
    }
    throw err;
  }

  const updated = await env.DB.prepare('SELECT featured_until FROM listings WHERE id = ?')
    .bind(id)
    .first();

  return json(env, request, { ok: true, featuredUntil: updated.featured_until, spent: cost });
}

/**
 * A tester asks to join a `testing` listing — the equivalent of TrustMRR's
 * "Contact Seller": a short pitch (`message`), reviewed by the owner before
 * it becomes an active test (see routes/testSessions.js `accept`/`decline`).
 *
 * No sign-in wall beforehand. If the caller already has a session cookie,
 * it's used as-is; otherwise `email`/`name` create or reuse an account by
 * email and a magic link is sent so they can come back and track it — the
 * account is created the same way a real sign-in does (see
 * `getOrCreateUser`), just from a different entry point than the "Sign in"
 * button, so nobody skips proving they own that inbox before ever getting
 * a session.
 */
export async function request(request, env, id) {
  const listing = await env.DB.prepare('SELECT * FROM listings WHERE id = ?').bind(id).first();
  if (!listing || listing.status !== 'open') return error(env, request, 404, 'listing not found');
  if (listing.kind !== 'testing') {
    return error(env, request, 400, 'this listing is not looking for testers');
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return error(env, request, 400, 'expected JSON body');
  }

  const message = String(body?.message ?? '');
  if (!isValidMessage(message, { min: MIN_REQUEST_MESSAGE_LENGTH, max: MAX_REQUEST_MESSAGE_LENGTH })) {
    return error(
      env,
      request,
      400,
      `message must be at least ${MIN_REQUEST_MESSAGE_LENGTH} characters — say what device/OS you're on and why you're a fit`,
    );
  }

  let user = await currentUser(env, request);
  let magicLinkSent = false;

  if (!user) {
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!isValidEmail(email)) return error(env, request, 400, 'a valid email is required');

    const name = String(body?.name ?? '').trim().slice(0, MAX_NAME_LENGTH);
    if (!name) return error(env, request, 400, 'name is required');

    user = await getOrCreateUser(env, email);
    if (!user.display_name) {
      await env.DB.prepare('UPDATE users SET display_name = ? WHERE id = ? AND display_name IS NULL')
        .bind(name, user.id)
        .run();
    }

    const token = await issueMagicLink(env, email);
    if (token && env.DEV_EXPOSE_LINKS !== 'true') {
      await sendMagicLinkEmail(env, email, token);
    }
    magicLinkSent = true;
  }

  if (listing.owner_user_id === user.id) {
    return error(env, request, 400, "you can't request to test your own listing");
  }

  const sessionId = newId();
  try {
    await env.DB.prepare(
      'INSERT INTO test_sessions (id, listing_id, tester_user_id, request_message) VALUES (?, ?, ?, ?)',
    )
      .bind(sessionId, id, user.id, message.trim())
      .run();
  } catch {
    return error(env, request, 409, 'you already requested to test this listing');
  }

  return json(env, request, { ok: true, sessionId, magicLinkSent }, { status: 201 });
}
