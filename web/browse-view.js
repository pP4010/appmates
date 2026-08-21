/**
 * Full listing browser shown inside `#browseView` on the landing page — the
 * same "swap the central content, keep the rails" trick `sponsor-view.js`
 * uses, opened from the "Browse every listing looking for testers" /
 * "See every launch and update" cards instead of a cross-page jump into the
 * dashboard. One table, two kinds (`testing`/`launch`), filtered by category
 * and platform the way canivibecodeit's Death List filters its own table.
 *
 * Category is not data the community backend stores (an app's genre is an
 * Apple/Google catalogue fact, not a listing field) — it's read the same way
 * the leaderboard reads it, one throttled `ITunesClient.lookup` per app,
 * patched in once it resolves. The category dropdown is built from whatever
 * has resolved so far rather than a fixed list, since nothing here is
 * pre-computed at build time the way Death List's 1,093-app list is.
 */

import { escapeHtml } from './views/shared.js';
import { CommunityClient, itunesRelayOptions } from './lib/community.js';
import { ITunesClient } from './lib/itunes.js';
import { DEMO_TESTING, DEMO_LAUNCHED } from './landing-demo.js';

const community = new CommunityClient();
const itunes = new ITunesClient(itunesRelayOptions());

/** Apple's endpoint is throttled by `ITunesClient` itself, but a 200-row
 * browse view still shouldn't queue 200 lookups the moment it opens — the
 * rows below the fold get their category once you'd actually scroll to
 * them, same trade-off `be-tester.js` makes with `MAX_ENRICHED_CARDS`. */
const CATEGORY_LOOKUP_LIMIT = 30;

const PLATFORM_LABEL = { ios: 'iOS', android: 'Android', both: 'Both' };

/** One emoji per Apple/Google catalogue genre — the same "each option gets
 * an emoji" treatment Death List's own category list uses, applied to
 * *our* categories since they come from a different taxonomy (App Store
 * genre names, not Death List's own SaaS categories). `📱` covers any genre
 * not worth a dedicated icon rather than leaving it bare. */
const CATEGORY_EMOJI = {
  'Business': '💼',
  'Developer Tools': '🛠️',
  'Education': '🎓',
  'Entertainment': '🎬',
  'Finance': '💰',
  'Food & Drink': '🍔',
  'Games': '🎮',
  'Graphics & Design': '🎨',
  'Health & Fitness': '💪',
  'Lifestyle': '🌿',
  'Magazines & Newspapers': '📰',
  'Medical': '🩺',
  'Music': '🎵',
  'Navigation': '🧭',
  'News': '📰',
  'Photo & Video': '📸',
  'Productivity': '⚡',
  'Reference': '📚',
  'Shopping': '🛍️',
  'Social Networking': '👥',
  'Sports': '⚽',
  'Travel': '✈️',
  'Utilities': '🔧',
  'Weather': '⛅',
  'Books': '📖',
  'Kids': '🧒',
};

function categoryLabel(category) {
  return `${CATEGORY_EMOJI[category] || '📱'} ${category}`;
}

let listings = [];
let listingsLoaded = false;
let activeKind = 'testing';
let activeCategory = '';
let activePlatform = '';
/** Category label -> how many currently-loaded listings resolved to it.
 * Rebuilt after every enrichment pass; drives the dropdown's option list. */
let categoryCounts = new Map();

function platformBadge(platform) {
  const label = PLATFORM_LABEL[platform];
  if (!label) return '';
  return `<span class="pf-badge ${platform}">${label}</span>`;
}

function appStoreUrl(trackId) {
  return `https://apps.apple.com/app/id${encodeURIComponent(trackId)}`;
}

/** Demo rows for a deployment with no community backend configured — same
 * two real apps the rest of the landing page falls back to, tagged as a
 * kind/platform/category shape identical to a real listing's so `renderRows`
 * never needs to know which one it's drawing. */
function demoListings() {
  const fromTesting = DEMO_TESTING.map((a) => {
    const [filled, wanted] = String(a.testers ?? '0/12').split('/').map(Number);
    return {
      kind: 'testing',
      platform: 'ios',
      category: a.genre || null,
      tagline: a.note,
      slotsFilled: filled || 0,
      slotsWanted: wanted || 0,
      app: { name: a.name, trackId: a.trackId, artworkUrl: '', storeUrl: appStoreUrl(a.trackId), country: a.country },
    };
  });
  const fromLaunched = DEMO_LAUNCHED.map((a) => ({
    kind: 'launch',
    platform: 'ios',
    category: a.genre || null,
    tagline: a.note,
    app: { name: a.name, trackId: a.trackId, artworkUrl: '', storeUrl: appStoreUrl(a.trackId), country: a.country },
  }));
  return [...fromTesting, ...fromLaunched];
}

async function loadListingsOnce() {
  if (listingsLoaded) return;
  listingsLoaded = true;

  if (!community.configured) {
    listings = demoListings();
    return;
  }
  try {
    listings = await community.browseListings(undefined, 'newest');
  } catch {
    listings = demoListings();
  }
}

/** Resolves category (and, for a row still missing one — the demo fallback
 * rows, mainly — a real icon) for up to `CATEGORY_LOOKUP_LIMIT` distinct
 * apps, one at a time (Apple's endpoint, same as everywhere else this app
 * talks to it), re-rendering after each so the table fills in rather than
 * blocking on the whole batch. */
async function enrichCategories() {
  const pending = [];
  const seen = new Set();
  for (const l of listings) {
    if (!l.app?.trackId || seen.has(l.app.trackId)) continue;
    if (l.category && l.app.artworkUrl) continue;
    seen.add(l.app.trackId);
    pending.push(l);
    if (pending.length >= CATEGORY_LOOKUP_LIMIT) break;
  }
  if (!pending.length) return;

  for (const listing of pending) {
    let entry;
    try {
      entry = await itunes.lookup(String(listing.app.trackId), { country: listing.app.country || 'us' });
    } catch {
      continue;
    }
    if (!entry) continue;
    const genre = entry.primaryGenreName;
    const artwork = entry.artworkUrl100 ?? entry.artworkUrl512;
    for (const l of listings) {
      if (l.app?.trackId !== listing.app.trackId) continue;
      if (genre) l.category = genre;
      if (artwork && !l.app.artworkUrl) l.app.artworkUrl = artwork;
    }
    rebuildCategoryCounts();
    renderCategoryOptions();
    renderRows();
  }
}

function rebuildCategoryCounts() {
  categoryCounts = new Map();
  for (const l of listings) {
    if (l.kind !== activeKind || !l.category) continue;
    categoryCounts.set(l.category, (categoryCounts.get(l.category) || 0) + 1);
  }
}

function filteredListings() {
  return listings.filter((l) => {
    if (l.kind !== activeKind) return false;
    if (activeCategory && l.category !== activeCategory) return false;
    if (activePlatform && l.platform !== activePlatform) return false;
    return true;
  });
}

function browseRow(listing, rank) {
  const { app } = listing;
  const metric =
    listing.kind === 'testing' ? `${listing.slotsFilled ?? 0}/${listing.slotsWanted || '∞'}` : 'Live';
  const icon = app.artworkUrl
    ? `<img src="${escapeHtml(app.artworkUrl)}" alt="" width="24" height="24" loading="lazy">`
    : `<span class="browse-icon-fallback" aria-hidden="true">${escapeHtml((app.name || '?').trim()[0] || '?')}</span>`;

  return `
    <a class="browse-row" href="${escapeHtml(app.storeUrl || '#')}" target="_blank" rel="noopener">
      <span class="browse-c-app">
        <span class="browse-rank">${String(rank).padStart(2, '0')}</span>
        ${icon}
        <span class="browse-name">${escapeHtml(app.name || 'Unnamed app')}</span>
      </span>
      <span class="browse-c-cat">${listing.category ? escapeHtml(categoryLabel(listing.category)) : '—'}</span>
      <span class="browse-c-platform">${platformBadge(listing.platform)}</span>
      <span class="browse-c-metric">${escapeHtml(metric)}</span>
    </a>`;
}

function renderRows() {
  const rows = filteredListings();
  const body = document.getElementById('browseBody');
  const empty = document.getElementById('browseEmpty');
  const count = document.getElementById('browseCount');
  if (!body) return;

  body.innerHTML = rows.map((l, i) => browseRow(l, i + 1)).join('');
  empty.hidden = rows.length > 0;
  count.textContent = `${rows.length} listing${rows.length === 1 ? '' : 's'}`;
}

function renderCategoryOptions() {
  const panel = document.getElementById('browseCatPanel');
  if (!panel) return;

  const total = [...categoryCounts.values()].reduce((a, b) => a + b, 0);
  const options = [
    ['', '⚡ all categories', total],
    ...[...categoryCounts.entries()].sort((a, b) => b[1] - a[1]).map(([cat, n]) => [cat, categoryLabel(cat), n]),
  ];

  panel.innerHTML = options
    .map(
      ([value, label, n]) => `
      <button type="button" class="cat-opt${value === activeCategory ? ' active' : ''}" data-cat="${escapeHtml(value)}">
        <span class="co-label">${escapeHtml(label)}</span>
        <span class="co-count">${n}</span>
      </button>`,
    )
    .join('');

  panel.querySelectorAll('.cat-opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeCategory = btn.dataset.cat;
      document.getElementById('browseCatLabel').textContent =
        activeCategory ? categoryLabel(activeCategory) : '⚡ all categories';
      panel.hidden = true;
      document.getElementById('browseCatBtn').setAttribute('aria-expanded', 'false');
      renderRows();
    });
  });
}

function wireCategoryDropdown() {
  const btn = document.getElementById('browseCatBtn');
  const panel = document.getElementById('browseCatPanel');
  btn.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !e.target.closest('#browseCatDd')) {
      panel.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }
  });
}

function wirePlatformChips() {
  document.querySelectorAll('#browsePlatformFilter .vchip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#browsePlatformFilter .vchip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      activePlatform = chip.dataset.platform || '';
      renderRows();
    });
  });
}

/** The last column means something different per kind — how many slots are
 * filled, or just that the app shipped — so its header swaps with it rather
 * than sitting under a generic "Status" no matter what's below it. */
function applyKindLabels() {
  document.getElementById('browseTitle').textContent =
    activeKind === 'testing' ? 'Needs testers now' : 'Just launched';
  document.getElementById('browseMetricHead').textContent =
    activeKind === 'testing' ? 'Testers' : 'Status';
}

function wireKindToggle() {
  document.querySelectorAll('#browseKindToggle .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#browseKindToggle .seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      activeKind = btn.dataset.kind;
      activeCategory = '';
      document.getElementById('browseCatLabel').textContent = '⚡ all categories';
      applyKindLabels();
      rebuildCategoryCounts();
      renderCategoryOptions();
      renderRows();
    });
  });
}

let wired = false;

export function initBrowseView() {
  if (wired) return;
  wired = true;
  wireCategoryDropdown();
  wirePlatformChips();
  wireKindToggle();
}

export async function showBrowseView(kind) {
  document.getElementById('landingHome').hidden = true;
  document.getElementById('browseView').hidden = false;

  activeKind = kind === 'launch' ? 'launch' : 'testing';
  activeCategory = '';
  activePlatform = '';
  document.getElementById('browseCatLabel').textContent = '⚡ all categories';
  document.querySelectorAll('#browsePlatformFilter .vchip').forEach((c) => c.classList.toggle('active', !c.dataset.platform));
  document.querySelectorAll('#browseKindToggle .seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.kind === activeKind),
  );
  applyKindLabels();

  await loadListingsOnce();
  rebuildCategoryCounts();
  renderCategoryOptions();
  renderRows();
  enrichCategories();
}

export function hideBrowseView() {
  document.getElementById('landingHome').hidden = false;
  document.getElementById('browseView').hidden = true;
}
