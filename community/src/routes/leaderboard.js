import { json } from '../lib/http.js';
import { publicDisplayName } from '../lib/reputation.js';
import {
  LEADERBOARD_DEFAULT_WINDOW_DAYS,
  LEADERBOARD_MAX_WINDOW_DAYS,
  LEADERBOARD_LIMIT,
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

const EARNED_IN_WINDOW = `
  SELECT u.id, u.display_name,
         COUNT(DISTINCT ts.id) AS completed_count,
         COALESCE(SUM(tl.delta), 0) AS tokens_earned
  FROM test_sessions ts
  JOIN users u ON u.id = ts.tester_user_id
  LEFT JOIN token_ledger tl ON tl.related_id = ts.id AND tl.reason = 'earned_test'
  WHERE ts.status = 'completed' AND ts.completed_at > datetime('now', ?)
`;

function resolveWindow(url) {
  const requested = Number(url.searchParams.get('window'));
  return Number.isFinite(requested) && requested > 0
    ? Math.min(Math.trunc(requested), LEADERBOARD_MAX_WINDOW_DAYS)
    : LEADERBOARD_DEFAULT_WINDOW_DAYS;
}

export async function top(request, env) {
  const windowDays = resolveWindow(new URL(request.url));
  const since = `-${windowDays} days`;

  // Board one: everyone who tested, whether or not they ship anything.
  const testers = await env.DB.prepare(
    `${EARNED_IN_WINDOW} GROUP BY u.id
     ORDER BY tokens_earned DESC, completed_count DESC LIMIT ?`,
  )
    .bind(since, LEADERBOARD_LIMIT)
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
      tokensEarned: r.tokens_earned,
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
