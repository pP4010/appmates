import { json, error } from '../lib/http.js';
import { currentUser, serializeUser } from '../lib/auth.js';
import { isHttpUrl } from '../lib/validate.js';
import { builderReliability } from '../lib/reputation.js';
import { MAX_NAME_LENGTH, MAX_BIO_LENGTH } from '../lib/config.js';

/**
 * Edits the signed-in user's own public profile — name, bio, avatar link.
 *
 * `display_name` used to be set once, at first test request, and frozen
 * (see the `AND display_name IS NULL` guard still in routes/listings.js
 * `request()`) — that guard is what a brand-new user gets by default, this
 * route is what lets anyone actually change it afterward, same as the rest
 * of the profile.
 */
export async function update(request, env) {
  const user = await currentUser(env, request);
  if (!user) return error(env, request, 401, 'sign in required');

  let body;
  try {
    body = await request.json();
  } catch {
    return error(env, request, 400, 'expected JSON body');
  }

  const displayName = String(body?.displayName ?? '').trim().slice(0, MAX_NAME_LENGTH);
  if (!displayName) return error(env, request, 400, 'name is required');

  const bio = typeof body?.bio === 'string' ? body.bio.trim().slice(0, MAX_BIO_LENGTH) : '';

  let avatarUrl = null;
  if (typeof body?.avatarUrl === 'string' && body.avatarUrl.trim()) {
    const trimmed = body.avatarUrl.trim().slice(0, 1000);
    if (!isHttpUrl(trimmed)) return error(env, request, 400, 'avatarUrl must be a valid http(s) image link');
    avatarUrl = trimmed;
  }

  await env.DB.prepare('UPDATE users SET display_name = ?, bio = ?, avatar_url = ? WHERE id = ?')
    .bind(displayName, bio || null, avatarUrl, user.id)
    .run();

  return json(env, request, {
    user: serializeUser({ ...user, display_name: displayName, bio: bio || null, avatar_url: avatarUrl }),
  });
}

/**
 * The same reliability/contribution numbers `LISTING_SELECT` in
 * routes/listings.js computes per-listing, scoped directly to a user id
 * instead of correlated through a listing row — a user has no listing at
 * all until they post one, and the profile page has to show these before
 * that's true. Kept as a separate, intentionally duplicated query rather
 * than sharing SQL text with `LISTING_SELECT`: that one correlates against
 * `l.owner_user_id` (a column on the joined row), this one binds a fixed
 * `?` — different enough shapes that forcing one query to serve both would
 * cost more clarity than the four-line duplication does.
 */
async function reliabilityStats(env, userId) {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM test_sessions ts JOIN listings l ON l.id = ts.listing_id
          WHERE l.owner_user_id = ? AND ts.status = 'completed') AS completed_count,
       (SELECT COUNT(*) FROM test_sessions ts JOIN listings l ON l.id = ts.listing_id
          WHERE l.owner_user_id = ? AND ts.status IN ('completed', 'declined', 'abandoned')) AS resolved_count,
       (SELECT AVG((julianday(ts.responded_at) - julianday(ts.created_at)) * 24)
          FROM test_sessions ts JOIN listings l ON l.id = ts.listing_id
          WHERE l.owner_user_id = ? AND ts.responded_at IS NOT NULL) AS avg_response_hours,
       (SELECT COUNT(*) FROM test_sessions ts WHERE ts.tester_user_id = ? AND ts.status = 'completed') AS contribution_count`,
  )
    .bind(userId, userId, userId, userId)
    .first();

  return {
    reliability: builderReliability({
      completedCount: row?.completed_count ?? 0,
      resolvedCount: row?.resolved_count ?? 0,
      avgResponseHours: row?.avg_response_hours ?? null,
    }),
    contribution: row?.contribution_count ?? 0,
  };
}

export async function stats(request, env) {
  const user = await currentUser(env, request);
  if (!user) return error(env, request, 401, 'sign in required');
  const { reliability, contribution } = await reliabilityStats(env, user.id);
  return json(env, request, { reliability, contribution });
}
