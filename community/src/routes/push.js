import { json, error, newId } from '../lib/http.js';
import { currentUser } from '../lib/auth.js';
import { ECHO_BOT_LISTING_ID } from '../lib/config.js';

/** Registers (or re-registers) one browser's push subscription against the
 * signed-in user. `endpoint` is unique per browser/device, not per user —
 * the same account subscribed on a phone and a laptop needs two rows to
 * receive a push on both, so re-subscribing the same browser upserts
 * instead of accumulating duplicates the push service would still accept
 * sends for. */
export async function subscribe(request, env) {
  const user = await currentUser(env, request);
  if (!user) return error(env, request, 401, 'sign in required');

  let body;
  try {
    body = await request.json();
  } catch {
    return error(env, request, 400, 'expected JSON body');
  }

  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : '';
  const p256dh = typeof body?.keys?.p256dh === 'string' ? body.keys.p256dh : '';
  const auth = typeof body?.keys?.auth === 'string' ? body.keys.auth : '';
  if (!endpoint || !p256dh || !auth) return error(env, request, 400, 'endpoint and keys are required');

  await env.DB.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
  )
    .bind(newId(), user.id, endpoint, p256dh, auth)
    .run();

  return json(env, request, { ok: true });
}

/** Explicit opt-out — scoped to the signed-in user so one browser can't
 * unsubscribe a device it doesn't own by guessing its endpoint URL. */
export async function unsubscribe(request, env) {
  const user = await currentUser(env, request);
  if (!user) return error(env, request, 401, 'sign in required');

  let body;
  try {
    body = await request.json();
  } catch {
    return error(env, request, 400, 'expected JSON body');
  }

  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : '';
  if (!endpoint) return error(env, request, 400, 'endpoint is required');

  await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?')
    .bind(endpoint, user.id)
    .run();
  return json(env, request, { ok: true });
}

/**
 * Gets or lazily creates the signed-in user's own test_sessions row against
 * the shared echo-bot listing (migrations/0005_echo_test_conversation.sql)
 * — created `accepted` outright, skipping the normal request/accept dance,
 * since there's no real owner on the other end to review anything. Once it
 * exists it's a completely ordinary messageable session and needs no
 * special handling anywhere else — it shows up in `mySessions()` and the
 * Inbox like any other conversation.
 */
export async function testSession(request, env) {
  const user = await currentUser(env, request);
  if (!user) return error(env, request, 401, 'sign in required');

  const existing = await env.DB.prepare('SELECT id FROM test_sessions WHERE listing_id = ? AND tester_user_id = ?')
    .bind(ECHO_BOT_LISTING_ID, user.id)
    .first();
  if (existing) return json(env, request, { sessionId: existing.id });

  const sessionId = newId();
  await env.DB.prepare(
    `INSERT INTO test_sessions (id, listing_id, tester_user_id, status, request_message, responded_at)
     VALUES (?, ?, ?, 'accepted', 'Automated — testing push notifications.', datetime('now'))`,
  )
    .bind(sessionId, ECHO_BOT_LISTING_ID, user.id)
    .run();

  return json(env, request, { sessionId });
}
