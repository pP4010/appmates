/**
 * Push notification handler. Deliberately at the site root, not under a
 * subdirectory — a service worker only controls pages within its own scope,
 * and both app.html and index.html need it.
 *
 * The one decision this makes: system notification, or in-app toast. Every
 * push the backend sends is the same "you have a new message" event
 * regardless of whether anyone's looking at the app right now — this is
 * where that gets resolved, not the server. A focused tab gets a toast via
 * `postMessage`; anything else gets a real OS-level notification, since
 * there's no page open to show a toast in.
 */

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    /* a push with no/unparseable payload still deserves an ack, just a plain one */
  }
  const { title = 'AppMates', body = '', url = './app.html#community' } = data;

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const focused = clientList.find((c) => c.focused);

      if (focused) {
        focused.postMessage({ type: 'appmates-message', title, body, url });
        return;
      }

      await self.registration.showNotification(title, {
        body,
        icon: './assets/icon.svg',
        badge: './assets/icon.svg',
        data: { url },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || './app.html#community';

  event.waitUntil(
    (async () => {
      const targetPath = new URL(url, self.location.origin).pathname;
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = clientList.find((c) => new URL(c.url).pathname === targetPath);

      if (existing) {
        existing.focus();
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
