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
    // `liveSince` is carried through both branches on purpose: this builds a
    // fresh object per slot rather than spreading the input, so anything not
    // named here is silently dropped — and the sponsor board reads it to
    // print "live since 14 Aug" under a taken slot.
    const fallback = {
      name: slot.name || 'Promoted app',
      genre: '',
      artwork: '',
      storeUrl: `https://apps.apple.com/app/id${encodeURIComponent(slot.trackId)}`,
      color: slot.color,
      liveSince: slot.liveSince ?? null,
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
              liveSince: slot.liveSince ?? null,
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

function openSlotItem(slotHref, label) {
  return `
    <a class="tape-item tape-item--open" href="${escapeHtml(slotHref)}">
      <img class="tape-icon" src="./assets/icon.svg" alt="" width="18" height="18">
      <span>${escapeHtml(label)}</span>
    </a>`;
}

/** Every real app, icon included, plus the permanent "slots open" pill —
 * one copy, before any doubling or repeating. Every real app always
 * renders through `tapeItem()` — an earlier version special-cased "fewer
 * than two apps" into a text-only pill that dropped the app's own icon
 * even when one had resolved. */
function singleTapeHtml(apps, slotHref) {
  const label = apps.length ? 'More slots open — claim one' : 'Sponsor slots open — claim one';
  return apps.map(tapeItem).join('') + openSlotItem(slotHref, label);
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
export function buildTapeTrack(apps, slotHref) {
  const single = singleTapeHtml(apps, slotHref);
  if (!apps.length) {
    return `<div class="tape-track tape-track--static">${single}</div>`;
  }
  return `<div class="tape-track"><div class="tape-half">${single}</div><div class="tape-half">${single}</div></div>`;
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
/** Pixels of `.tape-half` scrolled per second — the actual perceived speed,
 * unlike a fixed animation-duration. styles.css's own `tape-slide` rule
 * sets a plain `27s` as a static fallback (no-JS, or before this runs
 * once); everything mounted through here overrides it with a duration
 * computed from this constant instead, so speed stays constant no matter
 * how wide a half ends up — see the comment below on why that distinction
 * matters. */
// Matches CanIVibecodeIt's own sponsor tape almost exactly: measured live
// against theirs (.sp-tape-track), 2062.85px half / 70s = 29.47px/s.
const TAPE_PX_PER_SECOND = 29.5;
const TAPE_MIN_DURATION_S = 30;

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
 * A fixed animation-duration turns that repeating into a second bug: the
 * same `27s` stretched over a half 4x wider than before (a real 2-sponsor
 * page, repeated to fill a 1400px bar) plays 4x faster in pixels-per-second
 * than the same duration did over a naturally-wide test-mode half — the
 * exact "way too fast" jump a real, small sponsor count produced the
 * moment the width fill above started working. `animationDuration` is set
 * explicitly below from `TAPE_PX_PER_SECOND` instead, so however many
 * copies it took to fill the bar, the scroll always reads at the same
 * speed.
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
  const halfWidth = singleWidth * repeats;
  track.style.animationDuration = `${Math.max(TAPE_MIN_DURATION_S, halfWidth / TAPE_PX_PER_SECOND)}s`;
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
export function mountTape(container, apps, slotHref) {
  if (!container) return;
  container.innerHTML = buildTapeTrack(apps, slotHref);

  if (!apps.length) {
    mountedTapes.delete(container);
    return;
  }
  const singleHtml = singleTapeHtml(apps, slotHref);
  mountedTapes.set(container, singleHtml);
  fillTapeWidth(container, singleHtml);
  wireTapeResize();
}
