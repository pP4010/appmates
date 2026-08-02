import webpush from 'web-push';

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
 */
export async function notifyNewMessage(env, recipientUserId, { appName, preview }) {
  const { results } = await env.DB.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?')
    .bind(recipientUserId)
    .all();
  if (!results.length) return;

  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);

  const payload = JSON.stringify({
    title: `New message · ${appName}`,
    body: preview,
    url: `${env.APP_ORIGIN}${env.APP_PATH}#community`,
  });

  await Promise.all(
    results.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
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
