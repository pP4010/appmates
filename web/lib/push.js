/**
 * Browser push notifications for the messaging feature — see
 * `push-sw.js` for what happens once a push actually arrives.
 *
 * The public half of the VAPID key pair that signs every push. Safe to
 * ship here (it's exactly what `pushManager.subscribe` sends the browser's
 * push service as the `applicationServerKey`) — the private half never
 * leaves the Worker. Mirrors `VAPID_PUBLIC_KEY` in community/wrangler.jsonc;
 * if that ever rotates, this has to change with it.
 */
export const VAPID_PUBLIC_KEY =
  'BHjTxmOshkBZV5-6MzvVmjOrqz0K4doBP6jhHtXLTNL9zyNNsHNo-01ObmGFbkRE7s1v0XsoO6Y8b3OHJ-vo8r0';

function base64UrlToUint8Array(base64url) {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** `'default'` (never asked), `'granted'`, `'denied'`, or `'unsupported'` —
 * callers use this to decide whether an "enable notifications" prompt is
 * worth showing at all. */
export function pushPermissionState() {
  return pushSupported() ? Notification.permission : 'unsupported';
}

/**
 * Whether there's anything useful to offer the "enable notifications"
 * button for. Deliberately not just `pushPermissionState() === 'default'`:
 * permission is a one-way, permanent browser setting once granted, but
 * *subscribing* can still fail after that (exactly what happened before the
 * `serviceWorker.ready` fix above — permission got granted, then
 * `pushManager.subscribe` threw). A person in that state has permission
 * `'granted'` forever with no working subscription behind it and, without
 * this check, no way back to the button that would fix it.
 */
export async function needsPushEnable() {
  if (!pushSupported()) return false;
  const permission = Notification.permission;
  if (permission === 'default') return true;
  if (permission === 'denied') return false; // nothing a button here can do about that

  const registration = await navigator.serviceWorker.getRegistration('./push-sw.js');
  if (!registration) return true;
  const subscription = await registration.pushManager.getSubscription();
  return !subscription;
}

let swRegistration = null;

/**
 * `register()` resolves as soon as a registration exists — often while the
 * worker is still installing, not yet controlling anything. `subscribe()`
 * needs an *active* worker, so this waits on `serviceWorker.ready` (which
 * only resolves once one is) rather than the plain registration promise —
 * skipping that wait is what throws "Subscription failed - no active
 * Service Worker" on the very first call, before the worker's had time to
 * activate.
 */
async function ensureServiceWorker() {
  if (!swRegistration) {
    await navigator.serviceWorker.register('./push-sw.js');
    swRegistration = await navigator.serviceWorker.ready;
  }
  return swRegistration;
}

/**
 * Requests permission, subscribes with the browser's push service, and
 * registers the subscription with the backend. Throws on any refusal —
 * callers show the message, they don't need to distinguish "denied" from
 * "unsupported" from a network error beyond that.
 */
export async function enablePush(client) {
  if (!pushSupported()) throw new Error('Push notifications are not supported in this browser.');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission was not granted.');

  const registration = await ensureServiceWorker();
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToUint8Array(VAPID_PUBLIC_KEY),
  });

  const { endpoint, keys } = subscription.toJSON();
  await client.subscribePush({ endpoint, keys });
  return subscription;
}

/**
 * Relays the service worker's "a push arrived while a tab had focus"
 * message to an in-app toast. Registers the listener even before a
 * subscription exists — harmless, since nothing posts this message until
 * one does.
 */
export function listenForInAppToasts(onMessage) {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'appmates-message') onMessage(event.data);
  });
}
