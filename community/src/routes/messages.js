import { json, error, newId } from '../lib/http.js';
import { currentUser } from '../lib/auth.js';
import { isValidMessage } from '../lib/validate.js';
import { MAX_SESSION_MESSAGE_LENGTH, MIN_REPORT_REASON_LENGTH, MAX_REPORT_REASON_LENGTH } from '../lib/config.js';
import { notifyNewMessage, scheduleEchoReply } from '../lib/push.js';
import { ECHO_BOT_USER_ID } from '../lib/config.js';

/** Both parties on a test session — the only two people allowed to read or
 * post to its thread. Kept as one small lookup rather than joined into the
 * message queries below, so `list` and `send` share the exact same
 * membership check instead of two slightly different WHERE clauses.
 * `app_name` rides along for `send`'s push notification, not needed by
 * `list` but cheap enough not to warrant a second query. */
async function sessionParties(env, id) {
  return env.DB.prepare(
    `SELECT ts.id, ts.tester_user_id, l.owner_user_id AS listing_owner_id, a.name AS app_name
     FROM test_sessions ts
     JOIN listings l ON l.id = ts.listing_id
     JOIN apps a ON a.id = l.app_id
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

export async function send(request, env, id, ctx) {
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

  // Backgrounded so a slow or unreachable push service never delays this
  // response — the sender is waiting on it, the recipient's notification
  // is not something they're watching a spinner for.
  const recipientId = session.tester_user_id === user.id ? session.listing_owner_id : session.tester_user_id;
  if (recipientId === ECHO_BOT_USER_ID) {
    // The recipient here is the echo bot, which has no subscriptions of its
    // own — a real notifyNewMessage call would just be a no-op DB read.
    // What the sender actually wants is the bot's delayed reply back to
    // *them*, which is its own push a few seconds from now.
    ctx.waitUntil(
      scheduleEchoReply(env, {
        sessionId: id,
        appName: session.app_name,
        recipientUserId: user.id,
        originalText: text.trim(),
      }).catch((err) => console.error('echo reply failed', err)),
    );
  } else {
    ctx.waitUntil(
      notifyNewMessage(env, recipientId, { appName: session.app_name, preview: text.trim().slice(0, 120) }).catch(
        (err) => console.error('push notify failed', err),
      ),
    );
  }

  return json(env, request, { message: serialize(row) }, { status: 201 });
}

/**
 * Flags a conversation for manual review — the report itself is invisible
 * to the other party, and changes nothing about the session's state; it's
 * purely a signal into `reports` for an admin to look at by hand (see
 * `routes/reports.js`). Either party can report, same membership check as
 * everywhere else on this session.
 */
export async function report(request, env, id) {
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

  const reason = String(body?.reason ?? '');
  if (!isValidMessage(reason, { min: MIN_REPORT_REASON_LENGTH, max: MAX_REPORT_REASON_LENGTH })) {
    return error(env, request, 400, `reason must be ${MIN_REPORT_REASON_LENGTH}-${MAX_REPORT_REASON_LENGTH} characters`);
  }

  await env.DB.prepare(
    "INSERT INTO reports (id, reporter_user_id, target_type, target_id, reason) VALUES (?, ?, 'session', ?, ?)",
  )
    .bind(newId(), user.id, id, reason.trim())
    .run();

  return json(env, request, { ok: true }, { status: 201 });
}
