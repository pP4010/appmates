import { json, error } from '../lib/http.js';
import { currentUser } from '../lib/auth.js';
import { awardTokens } from '../lib/tokens.js';
import { TOKENS_PER_COMPLETED_TEST, MAX_FEEDBACK_LENGTH } from '../lib/config.js';

async function sessionWithListing(env, id) {
  return env.DB.prepare(
    `SELECT ts.*, l.owner_user_id AS listing_owner_id
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
    feedback: row.feedback,
    createdAt: row.created_at,
    submittedAt: row.submitted_at,
    completedAt: row.completed_at,
    listing: {
      id: row.listing_id,
      kind: row.kind,
      appName: row.name,
      artworkUrl: row.artwork_url,
      storeUrl: row.store_url,
    },
  };
}

/** The sessions the signed-in user is testing for, newest first — lets the
 * UI find "what did I already join" again after a reload without the
 * client having to remember session ids itself. */
export async function mine(request, env) {
  const user = await currentUser(env, request);
  if (!user) return error(env, request, 401, 'sign in required');

  const { results } = await env.DB.prepare(
    `SELECT ts.*, l.kind, a.name, a.artwork_url, a.store_url
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

/** The tester records that they actually tested and leaves feedback — seen
 * only by the listing's owner, never published anywhere public. This alone
 * does not earn a token; see `complete`. */
export async function submit(request, env, id) {
  const user = await currentUser(env, request);
  if (!user) return error(env, request, 401, 'sign in required');

  const session = await sessionWithListing(env, id);
  if (!session || session.tester_user_id !== user.id) {
    return error(env, request, 404, 'test session not found');
  }
  if (session.status !== 'joined') {
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

  await env.DB.prepare(
    'UPDATE test_sessions SET status = ?, feedback = ?, submitted_at = datetime(\'now\') WHERE id = ?',
  )
    .bind('submitted', feedback, id)
    .run();

  return json(env, request, { ok: true });
}

/**
 * Only the listing's OWNER can complete a session, and only completion
 * mints a token — never the tester's own action. That is the entire
 * anti-abuse mechanism: nobody can award themselves tokens, and the person
 * confirming the work is the one who actually benefited from it.
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

  await env.DB.prepare(
    'UPDATE test_sessions SET status = ?, completed_at = datetime(\'now\') WHERE id = ?',
  )
    .bind('completed', id)
    .run();
  await awardTokens(env, session.tester_user_id, TOKENS_PER_COMPLETED_TEST, 'earned_test', id);

  return json(env, request, { ok: true, tokensAwarded: TOKENS_PER_COMPLETED_TEST });
}
