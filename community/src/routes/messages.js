import { json, error, newId } from '../lib/http.js';
import { currentUser } from '../lib/auth.js';
import { isValidMessage } from '../lib/validate.js';
import { MAX_SESSION_MESSAGE_LENGTH } from '../lib/config.js';

/** Both parties on a test session — the only two people allowed to read or
 * post to its thread. Kept as one small lookup rather than joined into the
 * message queries below, so `list` and `send` share the exact same
 * membership check instead of two slightly different WHERE clauses. */
async function sessionParties(env, id) {
  return env.DB.prepare(
    `SELECT ts.id, ts.tester_user_id, l.owner_user_id AS listing_owner_id
     FROM test_sessions ts JOIN listings l ON l.id = ts.listing_id
     WHERE ts.id = ?`,
  )
    .bind(id)
    .first();
}

function isParty(session, userId) {
  return Boolean(session) && (session.tester_user_id === userId || session.listing_owner_id === userId);
}

function serialize(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    senderUserId: row.sender_user_id,
    body: row.body,
    createdAt: row.created_at,
  };
}

/**
 * The thread on one test session, oldest first — everything exchanged
 * after the opening pitch (`test_sessions.request_message`, unaffected by
 * this table). A flat unpaginated list on purpose: a pitch-and-feedback
 * exchange about one test run isn't going to run to thousands of messages,
 * and paginating it would be complexity with nothing behind it.
 */
export async function list(request, env, id) {
  const user = await currentUser(env, request);
  if (!user) return error(env, request, 401, 'sign in required');

  const session = await sessionParties(env, id);
  if (!isParty(session, user.id)) return error(env, request, 404, 'test session not found');

  const { results } = await env.DB.prepare(
    'SELECT * FROM session_messages WHERE session_id = ? ORDER BY created_at ASC',
  )
    .bind(id)
    .all();
  return json(env, request, { messages: results.map(serialize) });
}

export async function send(request, env, id) {
  const user = await currentUser(env, request);
  if (!user) return error(env, request, 401, 'sign in required');

  const session = await sessionParties(env, id);
  if (!isParty(session, user.id)) return error(env, request, 404, 'test session not found');

  let body;
  try {
    body = await request.json();
  } catch {
    return error(env, request, 400, 'expected JSON body');
  }

  const text = String(body?.body ?? '');
  if (!isValidMessage(text, { min: 1, max: MAX_SESSION_MESSAGE_LENGTH })) {
    return error(env, request, 400, `message must be 1-${MAX_SESSION_MESSAGE_LENGTH} characters`);
  }

  const msgId = newId();
  await env.DB.prepare('INSERT INTO session_messages (id, session_id, sender_user_id, body) VALUES (?, ?, ?, ?)')
    .bind(msgId, id, user.id, text.trim())
    .run();

  const row = await env.DB.prepare('SELECT * FROM session_messages WHERE id = ?').bind(msgId).first();
  return json(env, request, { message: serialize(row) }, { status: 201 });
}
