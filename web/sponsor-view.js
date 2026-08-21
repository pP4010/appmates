/**
 * The sponsor content shown inside `#sponsorView` on the landing page —
 * an in-page view, not a separate document, so the promoted rails either
 * side of it are never touched when it opens (see `landing.js`'s hash
 * handling in `boot()`). Builds its dynamic bits (stat band, live panel,
 * slot board, request form) into the static shell already in `index.html`,
 * the same split every other section of this page follows.
 */

import { escapeHtml } from './views/shared.js';
import { fetchSponsorSlots } from './lib/sponsor-tape.js';
import { RAIL_LEFT, RAIL_RIGHT } from './landing-demo.js';
import { openPromoModal } from './lib/promo-form.js';
import { mountGlobe } from './lib/globe.js';
import { flagFor, countryInSentence } from './lib/globe-centroids.js';
import { CommunityClient } from './lib/community.js';

const SLOTS_PER_SIDE = 5;
const SELLABLE_PER_SIDE = SLOTS_PER_SIDE - 1;
/** Matches the worker's snapshot cache (`PRESENCE_SNAPSHOT_CACHE_MS` is a
 * third of this): polling faster would mostly re-read the same cached
 * payload, and the globe interpolates nothing between updates anyway. */
const LIVE_POLL_MS = 30_000;
const CONTACT_EMAIL = 'kaizenapp.contact@gmail.com';

const community = new CommunityClient();
const numberFmt = new Intl.NumberFormat('en-US');
const dayFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** `page` is whatever `lib/presence.js` pings with. Mapped here rather than
 * server-side so re-wording the feed never needs a worker deploy. */
const PAGE_LABELS = { landing: 'the landing page', app: 'the dashboard', site: 'the site' };

function pageLabel(page) {
  return PAGE_LABELS[page] || 'the site';
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Counts an element's displayed number up (or down) from whatever it
 * currently shows to `target`, formatted with `numberFmt` along the way —
 * every headline figure on this page uses this rather than `setText` so a
 * number arriving, or updating on the 30s poll, reads as counting rather
 * than just swapping. Skipped entirely under `prefers-reduced-motion`, and
 * a no-op jump when the value hasn't actually changed.
 *
 * Stepped with `setTimeout`, not `requestAnimationFrame` — this section can
 * start its count-up while its tab is backgrounded (opened in a new tab,
 * the window minimised), and rAF callbacks are exactly the ones a browser
 * suspends there; a stat that stayed stuck at "—" until the tab regained
 * focus would be worse than no animation at all. `setTimeout` still runs
 * in the background (browsers only clamp its rate, never park it), and a
 * few-hundred-ms count-up has no need for frame-perfect timing anyway. */
function animateNumber(id, target) {
  const el = document.getElementById(id);
  if (!el) return;
  const to = Number(target) || 0;
  const from = Number(String(el.textContent).replace(/[^0-9.-]/g, '')) || 0;
  if (reducedMotion || from === to) {
    el.textContent = numberFmt.format(to);
    return;
  }
  const duration = 900;
  const stepMs = 30;
  const start = Date.now();
  const tick = () => {
    const t = Math.min(1, (Date.now() - start) / duration);
    const eased = 1 - (1 - t) ** 3; // ease-out cubic — fast start, settles gently
    el.textContent = numberFmt.format(Math.round(from + (to - from) * eased));
    if (t < 1) setTimeout(tick, stepMs);
  };
  tick();
}

function agoLabel(seconds) {
  if (seconds == null || seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

/** `2026-08-21` → `21 Aug`. Parsed as UTC explicitly: a bare date string is
 * read as local time by some engines and UTC by others, which is enough to
 * shift the displayed day by one. */
function shortDay(iso) {
  if (!iso) return '';
  const date = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.valueOf()) ? '' : dayFmt.format(date);
}

/* ============================ slot board ============================ */

function slotCard(app, { label, kind, liveSince }) {
  const chip =
    kind === 'house'
      ? '<span class="sponsor-chip sponsor-chip--house">Ours</span>'
      : kind === 'taken'
        ? '<span class="sponsor-chip sponsor-chip--taken">Taken</span>'
        : '<span class="sponsor-chip sponsor-chip--open">Open now</span>';

  if (kind === 'open') {
    return `
      <button type="button" class="sponsor-slot sponsor-slot--open">
        <span class="sponsor-slot-tag">${escapeHtml(label)}</span>
        ${chip}
        <span class="sponsor-slot-name">Your app here</span>
        <span class="sponsor-slot-note">Click to claim this slot.</span>
      </button>`;
  }

  // Borrows the rails' own `.rail-card--*` tints rather than restating ten
  // `color-mix` pairs here — same hue on the board as in the rail is the
  // point, and one source for it means they can't drift apart.
  const colorClass = app.color ? ` rail-card--${escapeHtml(app.color)}` : '';
  const since = shortDay(liveSince);
  const note = kind === 'house' ? 'Not for sale.' : since ? `Live since ${since}.` : 'Live.';
  return `
    <a class="sponsor-slot${colorClass}" href="${escapeHtml(app.storeUrl)}"
       target="_blank" rel="${kind === 'house' ? 'noopener' : 'sponsored noopener'}">
      <span class="sponsor-slot-tag">${escapeHtml(label)}</span>
      ${chip}
      ${app.artwork ? `<img class="sponsor-slot-icon" src="${escapeHtml(app.artwork)}" alt="" loading="lazy">` : ''}
      <span class="sponsor-slot-name">${escapeHtml(app.name)}</span>
      <span class="sponsor-slot-note">${escapeHtml(note)}${app.genre ? ` · ${escapeHtml(app.genre)}` : ''}</span>
    </a>`;
}

/** Slot 1 on each side is the house anchor and never sellable; the four
 * below it are. Returns how many of those four are actually taken, which is
 * what the stat band's fourth number is computed from. */
function renderSide(column, side, resolvedApps) {
  const [anchor, ...rest] = resolvedApps;
  const dynamic = rest.slice(0, SELLABLE_PER_SIDE);
  const prefix = side === 'left' ? 'L' : 'R';
  const rail = side === 'left' ? 'left rail' : 'right rail';

  const cards = [slotCard(anchor, { label: `Slot ${prefix}1 · ${rail}`, kind: 'house' })];
  for (let i = 0; i < SELLABLE_PER_SIDE; i++) {
    const app = dynamic[i];
    cards.push(
      slotCard(app, {
        label: `Slot ${prefix}${i + 2} · ${rail}`,
        kind: app ? 'taken' : 'open',
        liveSince: app?.liveSince,
      }),
    );
  }
  column.innerHTML = cards.join('');
  return dynamic.filter(Boolean).length;
}

let slotsLoaded = false;

/** Fetches and renders the board once — the slots aren't live data, so
 * there's no reason to refetch every time the view reopens in the same page
 * load. Deliberately not awaited alongside the globe fetch: each slot costs
 * an iTunes lookup, and the three fetch-backed stats shouldn't wait on the
 * catalogue to answer. */
async function loadSlotsOnce() {
  if (slotsLoaded) return;
  slotsLoaded = true;

  const leftCol = document.getElementById('sponsorLeftCol');
  const rightCol = document.getElementById('sponsorRightCol');
  const { left, right } = await fetchSponsorSlots({ staticLeft: RAIL_LEFT, staticRight: RAIL_RIGHT });
  const taken = renderSide(leftCol, 'left', left) + renderSide(rightCol, 'right', right);

  animateNumber('sponsorStatOpenNum', SELLABLE_PER_SIDE * 2 - taken);

  document.querySelectorAll('.sponsor-slot--open').forEach((btn) => {
    btn.addEventListener('click', () => openPromoModal());
  });
}

/* ============================ live panel ============================ */

const globeApi = { instance: null };
let liveTimer = null;

/** One request feeds the stat band, the counter, the feed, the country
 * chips and the globe — they always render together, so splitting them
 * would be a second round trip for nothing. */
async function refreshLive() {
  const countEl = document.getElementById('sponsorLiveCount');
  const subEl = document.getElementById('sponsorLiveSub');
  const feedEl = document.getElementById('sponsorLiveFeed');
  const chipsEl = document.getElementById('sponsorGlobeChips');

  if (!community.configured) {
    countEl.textContent = '—';
    subEl.textContent = 'Live figures need the community backend, not configured on this deployment.';
    return;
  }

  let data;
  try {
    data = await community.globeSnapshot();
  } catch {
    return; // leaves the last good render standing rather than blanking it
  }

  // Everything time-shaped is offset by how long the server's snapshot sat
  // in its cache, so a cached payload's "12s ago" doesn't read "12s ago"
  // for the whole window.
  const drift = Number(data.age) || 0;

  animateNumber('sponsorStatLive', data.live);
  animateNumber('sponsorStatVisits', data.allTime?.viewsPerMonth ?? 0);
  animateNumber('sponsorStatListings', data.site?.openListings ?? 0);
  animateNumber('sponsorWhyViews', data.allTime?.viewsPerMonth ?? 0);

  const since = shortDay(data.allTime?.since);

  animateNumber('sponsorLiveCount', data.live);
  subEl.textContent = data.live
    ? `from ${data.liveCountries} countr${data.liveCountries === 1 ? 'y' : 'ies'} · ` +
      `${numberFmt.format(data.allTime?.views ?? 0)} visits${since ? ` since ${since}` : ''}`
    : 'Nobody else is here right now.';

  const feed = (data.feed || []).map((entry) => ({ ...entry, ago: (entry.ago ?? 0) + drift }));
  feedEl.innerHTML = feed
    .map(
      (entry, i) => `
      <li${i === 0 ? ' class="sponsor-g-fresh"' : ''}>
        <span class="sponsor-g-dot" aria-hidden="true"></span>
        <span class="sponsor-g-line">${flagFor(entry.c) || '🌐'} someone in
          ${escapeHtml(countryInSentence(entry.c))}
          ${entry.ago < 120 ? 'is reading' : 'was reading'}
          ${escapeHtml(pageLabel(entry.page))}</span>
        <span class="sponsor-g-ago">${escapeHtml(agoLabel(entry.ago))}</span>
      </li>`,
    )
    .join('');

  chipsEl.innerHTML =
    (data.topCountries || [])
      .map((r) => `<span class="sponsor-g-chip">${flagFor(r.c)} ${escapeHtml(r.c)} ${numberFmt.format(r.n)}</span>`)
      .join('') + (data.moreCountries > 0 ? `<span class="sponsor-g-more">+ ${data.moreCountries} more</span>` : '');

  globeApi.instance?.setSnapshot({
    pins: (data.pins || []).map((pin) => ({ ...pin, ago: (pin.ago ?? 0) + drift })),
    feed: feed.map((entry) => ({ ...entry, pageLabel: pageLabel(entry.page) })),
  });

  const canvas = document.getElementById('sponsorGlobe');
  if (canvas) {
    canvas.setAttribute(
      'aria-label',
      `Globe of live visitors: ${data.live} on the site, from ${data.liveCountries} countries`,
    );
  }
}

/* ============================ notify form ============================ */

/** There is no waitlist backend, and standing one up for a page that has
 * eight slots would be more moving parts than the feature is worth — so
 * this composes a mail exactly the way `lib/promo-form.js` already falls
 * back to. The honeypot still runs first, so a bot never gets as far as
 * opening anything. */
function wireNotifyForm() {
  const form = document.getElementById('sponsorNotifyForm');
  const statusEl = document.getElementById('sponsorNotifyStatus');
  if (!form) return;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (document.getElementById('sponsorNotifyWebsite')?.value) return; // bot
    const email = document.getElementById('sponsorNotifyEmail')?.value.trim();
    if (!email) return;

    const subject = encodeURIComponent('AppMates — tell me when a sponsor slot opens');
    const body = encodeURIComponent(`Please let me know when a slot frees up.\n\nEmail: ${email}\n`);
    window.location.href = `mailto:${CONTACT_EMAIL}?subject=${subject}&body=${body}`;
    statusEl.textContent = "Opening your mail app — send it and you're on the list.";
  });
}

/* ============================ view lifecycle ============================ */

/** Builds the static-but-dynamic bits once — safe to call multiple times,
 * the form/globe mount is guarded so re-showing the view never double-
 * mounts either. */
export function initSponsorView() {
  loadSlotsOnce();
  globeApi.instance = mountGlobe(document.getElementById('sponsorGlobe'), {
    tip: document.getElementById('sponsorGlobeTip'),
  });
  wireNotifyForm();
}

/** A tab coming back from the background skipped its polls; catching up
 * here beats showing numbers up to another full interval stale. */
function onVisibility() {
  if (document.visibilityState !== 'hidden') refreshLive();
}

/** `side` highlights the column a visitor arrived from (an empty rail
 * card or tape "claim a slot" link) — see `landing.js`'s hash handling. */
export function showSponsorView(side) {
  document.getElementById('landingHome').hidden = true;
  document.getElementById('sponsorView').hidden = false;

  document.querySelectorAll('.sponsor-slot-col--highlight').forEach((el) => el.classList.remove('sponsor-slot-col--highlight'));
  if (side === 'left' || side === 'right') {
    const col = document.getElementById(side === 'left' ? 'sponsorLeftCol' : 'sponsorRightCol');
    col?.classList.add('sponsor-slot-col--highlight');
  }

  // Only now does the canvas have a box to measure — until the line above,
  // `hidden` gave it a `display: none` ancestor.
  globeApi.instance?.start();
  refreshLive();
  clearInterval(liveTimer);
  // Skips the fetch while the tab is backgrounded — a sponsor tab left open
  // and forgotten would otherwise poll forever for a globe nobody is
  // looking at. `onVisibility` below covers the return trip, so nothing is
  // stale for longer than one interval either way.
  liveTimer = setInterval(() => {
    if (document.visibilityState !== 'hidden') refreshLive();
  }, LIVE_POLL_MS);
  document.addEventListener('visibilitychange', onVisibility);
}

export function hideSponsorView() {
  document.getElementById('landingHome').hidden = false;
  document.getElementById('sponsorView').hidden = true;

  globeApi.instance?.stop();
  clearInterval(liveTimer);
  liveTimer = null;
  document.removeEventListener('visibilitychange', onVisibility);
}
