import webpush from 'web-push';
import { newId } from './http.js';
import { adminUserIds } from './auth.js';
import { ECHO_BOT_USER_ID, ECHO_REPLY_DELAY_MS } from './config.js';

/**
 * The low-level send: every subscription one user has, one payload, no
 * opinion about what triggered it. `notifyNewMessage` and
 * `notifyAdminsOfReportPush` below are both just this plus their own
 * payload shape and (for messages) a mute check.
 */
async function sendPushToUser(env, userId, payload) {
  const { results } = await env.DB.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?')
    .bind(userId)
    .all();
  if (!results.length) return;

  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const payloadJson = JSON.stringify(payload);

  await Promise.all(
    results.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payloadJson,
        );
      } catch (err) {
        // 404/410 means the push service itself has discarded this
        // subscription (browser data cleared, extension uninstalled,
        // endpoint expired) — prune it rather than paying to retry
        // something that will never succeed again. Anything else is
        // logged and left alone; it might be transient.
        if (err.statusCode === 404 || err.statusCode === 410) {
          await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(sub.id).run();
        } else {
          console.error('push send failed', sub.id, err.statusCode, err.message);
        }
      }
    }),
  );
}

/**
 * Sends a "new message" push to every browser the recipient has subscribed
 * on. Fire-and-forget by design — the caller wraps this in `ctx.waitUntil`
 * so a slow or unreachable push service never delays the message-send
 * response the sender is waiting on.
 *
 * The client decides, per subscription, whether to surface this as a
 * system notification or an in-app toast (see web/push-sw.js) — this
 * function's only job is getting the encrypted payload to whichever
 * browsers are subscribed at all.
 *
 * `sessionId` gates on `muted_conversations` before any of that: mute is a
 * per-user, per-conversation preference, and unlike favourite/hidden/
 * archived in the Inbox it has to live server-side — the decision of
 * whether to send a push at all is made here, and a Service Worker has no
 * access to the browser's localStorage to check a client-side flag
 * against.
 */
export async function notifyNewMessage(env, recipientUserId, { sessionId, appName, preview }) {
  if (sessionId) {
    const muted = await env.DB.prepare('SELECT 1 FROM muted_conversations WHERE user_id = ? AND session_id = ?')
      .bind(recipientUserId, sessionId)
      .first();
    if (muted) return;
  }

  await sendPushToUser(env, recipientUserId, {
    title: `New message · ${appName}`,
    body: preview,
    url: `${env.APP_ORIGIN}${env.APP_PATH}#community`,
  });
}

/**
 * The immediate half of report alerting — a push to every admin who's
 * subscribed, the moment a report lands. `routes/reports.js`
 * `escalateUnseenReports` is the other half: an email, but only if 48
 * hours pass with nobody having opened `#admin` to see this. Never mutes
 * (there's no conversation-scoped mute check here, unlike
 * `notifyNewMessage` — an admin alert isn't something a report's *subject*
 * could ever silence).
 */
export async function notifyAdminsOfReportPush(env, { appName, reason }) {
  const adminIds = await adminUserIds(env);
  if (!adminIds.length) return;

  const payload = {
    title: `Reported · ${appName || 'conversation'}`,
    body: reason.slice(0, 140),
    url: `${env.APP_ORIGIN}${env.APP_PATH}#admin`,
  };
  await Promise.all(adminIds.map((id) => sendPushToUser(env, id, payload)));
}

/**
 * The echo bot's half of a conversation: waits a few seconds, inserts a
 * reply "from" `ECHO_BOT_USER_ID`, and pushes it to the real user exactly
 * the way a real reply would be — same insert, same `notifyNewMessage`.
 * The delay is deliberate, not incidental: it gives you time to background
 * the tab (or close it) after sending, so what you're watching for is the
 * system-notification path, not just the in-app-toast one `scheduleEchoReply`
 * would still return during if it replied instantly.
 *
 * Called via `ctx.waitUntil` from `routes/messages.js`, so this runs after
 * the sender's own request has already returned — `scheduler.wait` doesn't
 * burn CPU time while it waits, only wall-clock, which `waitUntil` grants
 * up to 30 seconds of.
 */
export async function scheduleEchoReply(env, { sessionId, appName, recipientUserId, originalText }) {
  await scheduler.wait(ECHO_REPLY_DELAY_MS);

  const body = `Echo: ${originalText}`.slice(0, 500);
  await env.DB.prepare('INSERT INTO session_messages (id, session_id, sender_user_id, body) VALUES (?, ?, ?, ?)')
    .bind(newId(), sessionId, ECHO_BOT_USER_ID, body)
    .run();

  await notifyNewMessage(env, recipientUserId, { sessionId, appName, preview: body });
}
