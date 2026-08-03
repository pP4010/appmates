import { json, error } from '../lib/http.js';
import { currentUser } from '../lib/auth.js';
import { awardTokens } from '../lib/tokens.js';
import { TOKENS_PER_COMPLETED_TEST, MAX_FEEDBACK_LENGTH } from '../lib/config.js';

const WOULD_USE_AGAIN = new Set(['yes', 'no', 'maybe']);

async function sessionWithListing(env, id) {
  return env.DB.prepare(
    `SELECT ts.*, l.owner_user_id AS listing_owner_id, l.slots_wanted
     FROM test_sessions ts JOIN listings l ON l.id = ts.listing_id
     WHERE ts.id = ?`,
  )
    .bind(id)
    .first();
}

function serializeSession(row) {
  return {
    id: row.id,
    status: row.status,
    requestMessage: row.request_message,
    feedback: row.feedback,
    bugFound: row.bug_found === null ? null : Boolean(row.bug_found),
    wouldUseAgain: row.would_use_again,
    createdAt: row.created_at,
    respondedAt: row.responded_at,
    submittedAt: row.submitted_at,
    completedAt: row.completed_at,
    listing: {
      id: row.listing_id,
      kind: row.kind,
      platform: row.platform,
      link: row.link,
      description: row.description,
      appName: row.name,
      artworkUrl: row.artwork_url,
      storeUrl: row.store_url,
    },
  };
}

/** The sessions the signed-in user has requested or is testing for, newest
 * first — including ones still `requested`, so a tester can see what's
 * still awaiting a reply without the client remembering session ids.
 * `l.link`/`l.description`/`l.platform` ride along for the Inbox's details
 * pane (views/inbox.js) — not needed by `mySessionCard` in
 * views/community.js, but cheap enough not to warrant a second query. */
export async function mine(request, env) {
  const user = await currentUser(env, request);
  if (!user) return error(env, request, 401, 'sign in required');

  const { results } = await env.DB.prepare(
    `SELECT ts.*, l.kind, l.platform, l.link, l.description, a.name, a.artwork_url, a.store_url
     FROM test_sessions ts
     JOIN listings l ON l.id = ts.listing_id
     JOIN apps a ON a.id = l.app_id
     WHERE ts.tester_user_id = ?
     ORDER BY ts.created_at DESC`,
  )
    .bind(user.id)
    .all();
  return json(env, request, { sessions: results.map(serializeSession) });
}

/**
 * The listing's owner accepts a pending request, turning it into an active
 * test. Capped at `slots_wanted` (when set) so accepting can't silently
 * overbook a closed track beyond what the store side actually allows.
 */
export async function accept(request, env, id) {
  const user = await currentUser(env, request);
  if (!user) return error(env, request, 401, 'sign in required');

  const session = await sessionWithListing(env, id);
  if (!session || session.listing_owner_id !== user.id) {
    return error(env, request, 404, 'test session not found');
  }
  if (session.status !== 'requested') {
    return error(env, request, 400, `cannot accept from status "${session.status}"`);
  }

  if (session.slots_wanted > 0) {
    const filled = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM test_sessions
       WHERE listing_id = ? AND status IN ('accepted', 'submitted', 'completed')`,
    )
      .bind(session.listing_id)
      .first();
    if ((filled?.n ?? 0) >= session.slots_wanted) {
      return error(env, request, 409, 'all testing slots are already filled');
    }
  }

  await env.DB.prepare(
    "UPDATE test_sessions SET status = 'accepted', responded_at = datetime('now') WHERE id = ?",
  )
    .bind(id)
    .run();
  return json(env, request, { ok: true });
}

/** The listing's owner declines a pending request. The tester keeps their
 * one shot at this listing spent (`UNIQUE(listing_id, tester_user_id)`) —
 * a decline is a real answer, not a retryable error. */
export async function decline(request, env, id) {
  const user = await currentUser(env, request);
  if (!user) return error(env, request, 401, 'sign in required');

  const session = await sessionWithListing(env, id);
  if (!session || session.listing_owner_id !== user.id) {
    return error(env, request, 404, 'test session not found');
  }
  if (session.status !== 'requested') {
    return error(env, request, 400, `cannot decline from status "${session.status}"`);
  }

  await env.DB.prepare(
    "UPDATE test_sessions SET status = 'declined', responded_at = datetime('now') WHERE id = ?",
  )
    .bind(id)
    .run();
  return json(env, request, { ok: true });
}

/** The tester records that they actually tested and leaves feedback — seen
 * only by the listing's owner, never published anywhere public. This alone
 * does not earn a token; see `complete`. The two structured fields exist
 * purely to help the owner's review decision; they feed nothing automatic. */
export async function submit(request, env, id) {
  const user = await currentUser(env, request);
  if (!user) return error(env, request, 401, 'sign in required');

  const session = await sessionWithListing(env, id);
  if (!session || session.tester_user_id !== user.id) {
    return error(env, request, 404, 'test session not found');
  }
  if (session.status !== 'accepted') {
    return error(env, request, 400, `cannot submit from status "${session.status}"`);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return error(env, request, 400, 'expected JSON body');
  }
  const feedback = String(body?.feedback ?? '').trim().slice(0, MAX_FEEDBACK_LENGTH);
  if (!feedback) return error(env, request, 400, 'feedback is required');

  const bugFound = typeof body?.bugFound === 'boolean' ? (body.bugFound ? 1 : 0) : null;
  const wouldUseAgain = WOULD_USE_AGAIN.has(body?.wouldUseAgain) ? body.wouldUseAgain : null;

  await env.DB.prepare(
    `UPDATE test_sessions
     SET status = 'submitted', feedback = ?, bug_found = ?, would_use_again = ?, submitted_at = datetime('now')
     WHERE id = ?`,
  )
    .bind(feedback, bugFound, wouldUseAgain, id)
    .run();

  return json(env, request, { ok: true });
}

/**
 * Only the listing's OWNER can complete a session, and only completion
 * mints a token — never the tester's own action. That is the entire
 * anti-abuse mechanism: nobody can award themselves tokens, and the person
 * confirming the work is the one who actually benefited from it. This is
 * also the only input the leaderboard (routes/leaderboard.js) ever counts —
 * automatic everywhere except the one step that has to stay manual.
 */
export async function complete(request, env, id) {
  const user = await currentUser(env, request);
  if (!user) return error(env, request, 401, 'sign in required');

  const session = await sessionWithListing(env, id);
  if (!session || session.listing_owner_id !== user.id) {
    return error(env, request, 404, 'test session not found');
  }
  if (session.status !== 'submitted') {
    return error(env, request, 400, 'the tester has not submitted feedback yet');
  }

  // The status update rides in the same D1 batch as the token award (see
  // `awardTokens`/`applyDelta` in lib/tokens.js) so the two can never split:
  // a session left `completed` with no token minted (unrecoverable — the
  // status guard above blocks any retry) was a real failure mode when these
  // were two separate calls.
  await awardTokens(env, session.tester_user_id, TOKENS_PER_COMPLETED_TEST, 'earned_test', id, [
    env.DB.prepare(
      'UPDATE test_sessions SET status = ?, completed_at = datetime(\'now\') WHERE id = ?',
    ).bind('completed', id),
  ]);

  return json(env, request, { ok: true, tokensAwarded: TOKENS_PER_COMPLETED_TEST });
}
