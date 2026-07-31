import { json } from '../lib/http.js';
import { publicDisplayName } from '../lib/reputation.js';
import {
  LEADERBOARD_DEFAULT_WINDOW_DAYS,
  LEADERBOARD_MAX_WINDOW_DAYS,
  LEADERBOARD_LIMIT,
  LEADERBOARD_MAX_LIMIT,
  CONTRIBUTOR_SHOWCASE_LIMIT,
} from '../lib/config.js';

/**
 * Everything on this page is recomputed per request from `completed` test
 * sessions — and a session only reaches `completed` when a listing owner
 * confirms by hand that a tester really helped (see routes/testSessions.js).
 * So the ranking is fully automatic while remaining impossible to
 * self-award: the standing is computed, the credit behind it never is.
 *
 * A trailing window rather than all-time, so the board reflects who is
 * showing up now instead of freezing whoever arrived first.
 */

// `apps_helped` counts distinct listings rather than sessions: helping the
// same app through three rounds is real work, but it is not the same reach
// as helping three different developers ship, and the board says which.
// The tester's own app, if they have connected one — the board shows what
// each person is building next to what they gave, and a dash when they are
// here purely to test. Only `track_id` and enough to label it: the rating
// count beside it is re-read from the public catalogue by the client, never
// stored here, so nothing in this database tracks a store rating.
const EARNED_IN_WINDOW = `
  SELECT u.id, u.display_name,
         COUNT(DISTINCT ts.id) AS completed_count,
         COUNT(DISTINCT ts.listing_id) AS apps_helped,
         MAX(ts.completed_at) AS last_active_at,
         COALESCE(SUM(tl.delta), 0) AS tokens_earned,
         (SELECT a.name FROM apps a
            WHERE a.owner_user_id = u.id ORDER BY a.created_at DESC LIMIT 1) AS own_app_name,
         (SELECT a.track_id FROM apps a
            WHERE a.owner_user_id = u.id ORDER BY a.created_at DESC LIMIT 1) AS own_app_track_id,
         (SELECT a.country FROM apps a
            WHERE a.owner_user_id = u.id ORDER BY a.created_at DESC LIMIT 1) AS own_app_country
  FROM test_sessions ts
  JOIN users u ON u.id = ts.tester_user_id
  LEFT JOIN token_ledger tl ON tl.related_id = ts.id AND tl.reason = 'earned_test'
  WHERE ts.status = 'completed' AND ts.completed_at > datetime('now', ?)
`;

// Safelisted, so a sort name off the query string can never reach the SQL.
// Same property the `resolveSort` in routes/listings.js relies on, and the
// `typeof` guard is there for the same reason: a property key is coerced
// with `toString()`, so an array would otherwise match what it stringifies to.
// Two genuinely different questions: how many sessions someone completed,
// and how many separate developers they helped. Ranking by tokens would be
// a third name for the first — one completed test mints exactly one token.
const SORTS = {
  tests: 'completed_count DESC, apps_helped DESC',
  apps: 'apps_helped DESC, completed_count DESC',
};

export function resolveSort(sort) {
  if (typeof sort !== 'string') return SORTS.tests;
  return Object.hasOwn(SORTS, sort) ? SORTS[sort] : SORTS.tests;
}

function resolveWindow(url) {
  const requested = Number(url.searchParams.get('window'));
  return Number.isFinite(requested) && requested > 0
    ? Math.min(Math.trunc(requested), LEADERBOARD_MAX_WINDOW_DAYS)
    : LEADERBOARD_DEFAULT_WINDOW_DAYS;
}

function resolveLimit(url) {
  const requested = Number(url.searchParams.get('limit'));
  return Number.isFinite(requested) && requested > 0
    ? Math.min(Math.trunc(requested), LEADERBOARD_MAX_LIMIT)
    : LEADERBOARD_LIMIT;
}

export async function top(request, env) {
  const url = new URL(request.url);
  const windowDays = resolveWindow(url);
  const since = `-${windowDays} days`;
  const orderBy = resolveSort(url.searchParams.get('sort'));
  const limit = resolveLimit(url);

  // Board one: everyone who tested, whether or not they ship anything.
  const testers = await env.DB.prepare(
    `${EARNED_IN_WINDOW} GROUP BY u.id ORDER BY ${orderBy} LIMIT ?`,
  )
    .bind(since, limit)
    .all();

  // Board two: the same score, narrowed to people who also have something
  // open for others to test. These are the developers who give back while
  // asking — the ones whose listings the showcase below then surfaces.
  const contributors = await env.DB.prepare(
    `${EARNED_IN_WINDOW}
       AND EXISTS (SELECT 1 FROM listings l
                   WHERE l.owner_user_id = u.id AND l.status = 'open')
     GROUP BY u.id
     ORDER BY tokens_earned DESC, completed_count DESC LIMIT ?`,
  )
    .bind(since, CONTRIBUTOR_SHOWCASE_LIMIT)
    .all();

  const listingsByOwner = await openListingsFor(
    env,
    contributors.results.map((r) => r.id),
  );

  return json(env, request, {
    windowDays,
    testers: testers.results.map((r, i) => ({
      rank: i + 1,
      displayName: publicDisplayName({ displayName: r.display_name, id: r.id }),
      completedCount: r.completed_count,
      appsHelped: r.apps_helped,
      lastActiveAt: r.last_active_at,
      tokensEarned: r.tokens_earned,
      ownApp: r.own_app_track_id
        ? { name: r.own_app_name, trackId: r.own_app_track_id, country: r.own_app_country }
        : null,
    })),
    contributors: contributors.results.map((r, i) => ({
      rank: i + 1,
      displayName: publicDisplayName({ displayName: r.display_name, id: r.id }),
      completedCount: r.completed_count,
      tokensEarned: r.tokens_earned,
      listings: listingsByOwner.get(r.id) ?? [],
    })),
  });
}

/** One query for every showcased contributor's open listings, rather than a
 * lookup per row — the id list is short and built from ids this module just
 * read out of the database, never from the request. */
async function openListingsFor(env, ownerIds) {
  const byOwner = new Map();
  if (!ownerIds.length) return byOwner;

  const placeholders = ownerIds.map(() => '?').join(', ');
  const { results } = await env.DB.prepare(
    `SELECT l.id, l.owner_user_id, l.kind, l.platform, l.link, l.slots_wanted,
            a.track_id, a.name, a.artwork_url, a.country,
            (SELECT COUNT(*) FROM test_sessions ts
               WHERE ts.listing_id = l.id
                 AND ts.status IN ('accepted', 'submitted', 'completed')
            ) AS slots_filled
     FROM listings l JOIN apps a ON a.id = l.app_id
     WHERE l.owner_user_id IN (${placeholders}) AND l.status = 'open'
     ORDER BY l.created_at DESC`,
  )
    .bind(...ownerIds)
    .all();

  for (const row of results) {
    if (!byOwner.has(row.owner_user_id)) byOwner.set(row.owner_user_id, []);
    byOwner.get(row.owner_user_id).push({
      id: row.id,
      kind: row.kind,
      platform: row.platform,
      link: row.link,
      slotsWanted: row.slots_wanted,
      slotsFilled: row.slots_filled ?? 0,
      app: {
        trackId: row.track_id,
        name: row.name,
        artworkUrl: row.artwork_url,
        country: row.country,
      },
    });
  }
  return byOwner;
}
