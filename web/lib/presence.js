/**
 * Site-wide "who's here right now" heartbeat, feeding the sponsor view's
 * live globe (`web/sponsor-view.js`, `web/lib/globe.js`). Pings from every
 * page a tab has open, not only while the sponsor view is visible — the
 * counter is meant to read "on the site right now", matching how the
 * reference page frames it, not "currently looking at this pitch".
 */

const SESSION_KEY = 'appmates-presence-id';
// Was 20s; 60s cuts the site-wide write volume to D1 by 3x (this fires
// from every open tab on every page, not just the sponsor view) while
// staying well inside the server's live window (see
// PRESENCE_LIVE_WINDOW_SECONDS in community/src/lib/config.js, sized as a
// multiple of this so one delayed or dropped ping can't make someone
// flicker in and out of the "here right now" count).
const PING_INTERVAL_MS = 60_000;

/** One id per browser tab, for the tab's lifetime — `sessionStorage` (not
 * `localStorage`) so two tabs never collide on the same id and a closed
 * tab's row ages out on its own via the server's stale-row cleanup. */
function tabId() {
  let id = sessionStorage.getItem(SESSION_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

let started = false;

/** No-ops silently if the community backend isn't configured on this
 * deployment — same offline-safe pattern every other community feature on
 * this site follows — and only ever starts once per page load regardless
 * of how many callers ask. */
export function startPresencePing(client, page) {
  if (started || !client.configured) return;
  started = true;

  const id = tabId();
  const send = () => client.pingPresence({ id, page }).catch(() => {});
  send();
  setInterval(send, PING_INTERVAL_MS);
}
