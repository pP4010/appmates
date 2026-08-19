/**
 * Compact horizontal sponsor strip ("tape") shown wherever there isn't
 * room for a full vertical rail — the app dashboard's own width band, and
 * the landing page below the width its two rail columns need.
 *
 * Slot resolution lives here rather than in each page's own script so the
 * landing page's rails and the dashboard's tape draw from one iTunes
 * lookup / community fetch instead of two independent ones asking the same
 * questions.
 */

import { ITunesClient } from './itunes.js';
import { CommunityClient, itunesRelayOptions } from './community.js';
import { escapeHtml } from '../views/shared.js';

/**
 * Resolves `{trackId, country, name, color, empty}` slots into
 * `{name, genre, artwork, storeUrl, color}` via one iTunes lookup each —
 * `null` in the output marks a slot that's genuinely empty (nothing to
 * sell there yet). A lookup that fails or comes back empty still renders a
 * real, clickable sponsor built from the id alone: a slot someone paid for
 * stays visibly taken rather than reading as available because the
 * catalogue hiccupped.
 */
async function resolveSlots(slots, itunes) {
  const out = [];
  for (const slot of slots) {
    if (slot.empty || !slot.trackId) {
      out.push(null);
      continue;
    }
    const fallback = {
      name: slot.name || 'Promoted app',
      genre: '',
      artwork: '',
      storeUrl: `https://apps.apple.com/app/id${encodeURIComponent(slot.trackId)}`,
      color: slot.color,
    };
    try {
      const entry = await itunes.lookup(slot.trackId, { country: slot.country || 'us' });
      out.push(
        entry
          ? {
              name: entry.trackName,
              genre: entry.primaryGenreName ?? '',
              artwork: entry.artworkUrl100 ?? entry.artworkUrl512 ?? '',
              storeUrl: entry.trackViewUrl ?? '',
              color: slot.color,
            }
          : fallback,
      );
    } catch {
      out.push(fallback);
    }
  }
  return out;
}

/**
 * Merges the static rail config with community's approved "Feature your
 * app here" requests (see `views/admin.js`) — split left/right by parity,
 * same as the landing rails always have — then resolves both halves.
 * Pass an existing `itunes` client (a page that already made one for its
 * own tools) to share its cache and throttle; a fresh one is created only
 * when the caller has none.
 *
 * Returns each side as an array the same length as its input slots, with
 * `null` for an empty slot preserved — a rail needs that to know where to
 * paint an "Available" card; a tape just filters the nulls out.
 */
export async function fetchSponsorSlots({ staticLeft, staticRight, itunes }) {
  const client = itunes ?? new ITunesClient(itunesRelayOptions());
  const community = new CommunityClient();

  let dynamicLeft = [];
  let dynamicRight = [];
  if (community.configured) {
    try {
      const slots = await community.featuredPromoSlots();
      dynamicLeft = slots.filter((_, i) => i % 2 === 0);
      dynamicRight = slots.filter((_, i) => i % 2 === 1);
    } catch {
      /* static config below still resolves */
    }
  }

  const [left, right] = await Promise.all([
    resolveSlots([...staticLeft, ...dynamicLeft], client),
    resolveSlots([...staticRight, ...dynamicRight], client),
  ]);
  return { left, right };
}

function tapeItem(app) {
  return `
    <a class="tape-item" href="${escapeHtml(app.storeUrl)}" target="_blank" rel="sponsored noopener">
      ${
        app.artwork
          ? `<img class="tape-icon" src="${escapeHtml(app.artwork)}" alt="" width="18" height="18" loading="lazy">`
          : '<span class="tape-icon tape-icon--blank" aria-hidden="true"></span>'
      }
      <span>${escapeHtml(app.name)}</span>
    </a>`;
}

function openSlotItem(emailHref, label) {
  return `
    <a class="tape-item tape-item--open" href="${escapeHtml(emailHref)}">
      <img class="tape-icon" src="./assets/icon.svg" alt="" width="18" height="18">
      <span>${escapeHtml(label)}</span>
    </a>`;
}

/** Every real app, icon included, plus the permanent "slots open" pill —
 * one copy, before any doubling or repeating. Every real app always
 * renders through `tapeItem()` — an earlier version special-cased "fewer
 * than two apps" into a text-only pill that dropped the app's own icon
 * even when one had resolved. */
function singleTapeHtml(apps, emailHref) {
  const label = apps.length ? 'More slots open — get in touch' : 'Sponsor slots open — get in touch';
  return apps.map(tapeItem).join('') + openSlotItem(emailHref, label);
}

/**
 * Builds the doubled-track markup a seamless `.tape-track` scroll needs:
 * the same items twice back to back, animated to `translate(-50%)` so the
 * join between the two halves never shows — by the time the first half has
 * scrolled fully out of view, the second sits exactly where the first
 * started. Only true zero-app pages skip the animation entirely — nothing
 * to double, and no logo to hide a seam behind.
 *
 * Each half here is exactly one copy of the item list — enough to loop
 * correctly, but not necessarily enough to ever reach the far edge of a
 * wide screen. `mountTape` repeats it further before this ever paints; see
 * `fillTapeWidth`'s comment for why that second pass is the one that
 * actually matters.
 */
export function buildTapeTrack(apps, emailHref) {
  const single = singleTapeHtml(apps, emailHref);
  if (!apps.length) {
    return `<div class="tape-track tape-track--static">${single}</div>`;
  }
  return `<div class="tape-track"><div class="tape-half">${single}</div><div class="tape-half">${single}</div></div>`;
}

const MOCK_COLOR_HEX = {
  blue: '#2f5fa8', green: '#1f7a4d', violet: '#6d3aa8', orange: '#b5502a',
  pink: '#8a2f4a', teal: '#2c6470', red: '#a8342f', amber: '#a87e1f',
};
const MOCK_NAMES = [
  'Focusly', 'Streakloop', 'TabKeeper', 'Pingback',
  'Routinely', 'Ledgerbird', 'Snapcheck', 'Driftless',
];

/** A flat-color rounded square, inlined as a data URI — no network request,
 * so the test toggle works offline and never depends on a third-party
 * favicon or placeholder-image service staying up. Distinct colours per
 * mock app so the icon column reads as real logos rather than one grey
 * tile repeated ten times, the same failure mode the empty-artwork
 * fallback (`.tape-icon--blank`) is deliberately built to look like. */
function mockIcon(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">` +
    `<rect width="40" height="40" rx="9" fill="${MOCK_COLOR_HEX[color] || '#4a5568'}"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * `count` placeholder sponsors for visually testing the tape's density —
 * real icon, real name, real hover/click affordance, but no network lookup
 * behind any of it. Used by the dashboard's "Test tape" switch (see
 * `renderDashTape` in app.js) alongside the two real configured apps, to
 * check the marquee at a realistic 10-item width without waiting on actual
 * sponsors to sign up.
 */
export function mockSponsorApps(count = 8) {
  const colors = Object.keys(MOCK_COLOR_HEX);
  return Array.from({ length: count }, (_, i) => ({
    name: MOCK_NAMES[i % MOCK_NAMES.length],
    artwork: mockIcon(colors[i % colors.length]),
    storeUrl: 'https://apps.apple.com/',
    color: colors[i % colors.length],
  }));
}

/**
 * `translate(-50%)` slides a `.tape-half` across exactly its *own* width —
 * that's what makes the loop seamless — but a half narrower than the tape
 * container never reaches the container's far edge doing that: the whole
 * animation plays out within the half's own short span (near the left
 * third of the screen with, say, 2 real apps and one "More slots open"
 * pill) and the rest of the bar just sits empty. A test-mode density of
 * ~10 apps happens to already be wide enough to hide this, which is why it
 * only ever showed up with a real, small sponsor count. Fixed by repeating
 * the single-copy item list enough times that one half's width is at
 * least the container's — the loop still repeats the same items, just
 * enough copies of them to physically span (and keep moving all the way
 * across) the full bar regardless of how few sponsors there are.
 *
 * Measured with a throwaway off-screen probe rather than the live
 * `.tape-half` so repeated calls (a resize, see `wireTapeResize` below)
 * always compute from the one true single-copy width — measuring the live
 * half instead would compound on every call, since after the first fill
 * it already holds several copies.
 */
function fillTapeWidth(container, singleHtml) {
  const track = container.querySelector('.tape-track');
  if (!track) return;
  const containerWidth = container.getBoundingClientRect().width;
  if (!containerWidth) return;

  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;display:flex;white-space:nowrap;pointer-events:none';
  probe.innerHTML = singleHtml;
  container.appendChild(probe);
  const singleWidth = probe.getBoundingClientRect().width;
  probe.remove();
  if (!singleWidth) return;

  const repeats = Math.max(1, Math.ceil(containerWidth / singleWidth) + 1);
  const half = singleHtml.repeat(repeats);
  track.innerHTML = `<div class="tape-half">${half}</div><div class="tape-half">${half}</div>`;
}

/** Container → its one-copy item HTML, so a resize can re-run
 * `fillTapeWidth` from the canonical single copy without needing to
 * refetch sponsor data or re-derive it from the (possibly already
 * repeated) live DOM. */
const mountedTapes = new Map();
let resizeWired = false;

function wireTapeResize() {
  if (resizeWired) return;
  resizeWired = true;
  let timer;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    // A tape that's `display:none` at the moment of resize (mid-breakpoint
    // swap between the landing page's rails and its tape, say) skips the
    // fill — `fillTapeWidth` no-ops on a zero-width container — but stays
    // in the map so the very next resize that actually reveals it fills
    // correctly instead of showing whatever width happened to be current
    // the last time it was visible.
    timer = setTimeout(() => {
      for (const [container, singleHtml] of mountedTapes) fillTapeWidth(container, singleHtml);
    }, 150);
  });
}

/** Renders straight into a tape container; a no-op if the page has none. */
export function mountTape(container, apps, emailHref) {
  if (!container) return;
  container.innerHTML = buildTapeTrack(apps, emailHref);

  if (!apps.length) {
    mountedTapes.delete(container);
    return;
  }
  const singleHtml = singleTapeHtml(apps, emailHref);
  mountedTapes.set(container, singleHtml);
  fillTapeWidth(container, singleHtml);
  wireTapeResize();
}
