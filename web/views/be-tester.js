/**
 * Testing other developers' apps — the tester half of the Community
 * feature, split out from "Get testers" (the owner half) into its own
 * page since the two are different jobs done by different people at
 * different moments, even though the same account does both and the
 * whole thing only works because both halves exist: someone posts a
 * listing here on "Get testers", the same person shows up *here* on "Be
 * a tester" to earn the token that got them tested in return. One
 * reciprocal exchange, two doors into it depending which side you're on
 * right now.
 *
 * Three tabs: Marketplace (browse listings, request to join — no account
 * needed, same as it always was) and Leaderboard live here now instead of
 * on the owner page, since both are fundamentally "go test something",
 * not "manage my own listing". My testing is what used to be
 * community.js's "Apps you're testing" list, plus the one thing it didn't
 * have: a daily proof-of-testing check-in. A `submitted`/`completed`
 * session already carries a feedback write-up, but nothing between
 * accepting and submitting said whether the tester actually opened the
 * app more than once — a check-in (a photo, once a day,
 * `UNIQUE(session_id, checkin_date)` server-side) is a cheap, real signal
 * the listing owner can see building up, the same habit-tracker shape as
 * Play's own 12-testers-14-days streak (lib/testers.js), just from the
 * tester's side.
 */

import {
  el, escapeHtml, empty, withStatus, appIcon, bar, toneFor, MESSAGEABLE_STATUSES,
  reliabilityBadge, contributionBadge,
} from './shared.js';
import { checkAppHealth, profileFromEntry } from '../lib/app-profile.js';
import { messageThreadHtml, wireMessageThreads } from './community.js';
import { storeBadgeHtml } from '../lib/platform-badge.js';

// Mirrors MIN_REQUEST_MESSAGE_LENGTH in community/src/lib/config.js — the
// server is the real limit, this just keeps the on-page counter honest.
const MIN_MESSAGE_LENGTH = 20;

/** Catalogue lookups are throttled to protect Apple's endpoint, so a page of
 * cards enriches over a noticeable stretch of time. Capping keeps that from
 * running for minutes on a long list — the rows below the fold simply keep
 * their community-only numbers, which are still true. */
const MAX_ENRICHED_CARDS = 12;

const TABS = {
  browse: 'Marketplace',
  leaderboard: 'Leaderboard',
  mine: 'My testing',
};

const STATUS_LABEL = {
  requested: 'Waiting for review',
  declined: 'Declined',
  accepted: 'Accepted — go test it',
  submitted: 'Feedback submitted',
  completed: 'Completed',
  abandoned: 'Abandoned',
};

const STATUS_TONE = {
  requested: 'neutral',
  declined: 'bad',
  accepted: 'info',
  submitted: 'neutral',
  completed: 'ok',
  abandoned: 'neutral',
};

const STRIP_DAYS = 14;
const MAX_PHOTO_DIMENSION = 640;
const PHOTO_QUALITY = 0.6;
// A screenshot is a few MB at most; this is generous headroom over that so
// a real screenshot always sails through, while still stopping something
// picked by mistake (a multi-hundred-MB video or RAW photo) from being
// read into memory at all before compression even starts.
const MAX_SOURCE_FILE_BYTES = 25 * 1024 * 1024;

let client = null;
let itunes = null;
let getCurrentApp = null;
let user = null;
let activeTab = 'browse';
// '' (all), 'ios', 'android', or 'both' — the Marketplace tab's platform
// filter (renderBrowseTab/renderBrowse). Client-side only, same as
// browse-view.js's own `activePlatform`: `GET /listings` has no platform
// query param, so this narrows the already-fetched list.
let activePlatform = '';

// The last successful `renderBrowse` fetch — `null` until the first load.
// A platform-chip click re-filters these in memory (`renderFilteredResults`)
// instead of re-fetching, the same way browse-view.js's own platform chips
// never touch the network. Kind/sort genuinely change what the server
// returns, so those still trigger a real fetch, tracked here so a
// mid-flight one only actually replaces `#testerBrowseResults` (collapsing
// it to a spinner first) on the very first load — once real cards are on
// screen, a refresh keeps them in place instead of collapsing the page's
// height out from under the reader's scroll position.
let lastListings = null;
let lastMine = [];

/** Bumped on every tab switch or re-render. The progressive enrichment loop
 * carries the value it started with and stops the moment it no longer
 * matches, so a stale pass can never write into a page it no longer owns. */
let renderGeneration = 0;

export function initBeTester(communityClient, { getCurrentApp: getApp, itunes: itunesClient } = {}) {
  client = communityClient;
  getCurrentApp = getApp || (() => null);
  itunes = itunesClient ?? null;
  const navItem = document.querySelector('.nav-item[href="#be-tester"]');

  if (!client.configured) {
    navItem?.classList.add('hidden');
    el('testerBody').innerHTML = empty(
      '◑',
      'Not set up yet',
      'This deployment has no community backend configured. See community/README.md.',
    );
    return;
  }

  refresh();
}

/** Browsing, requesting to test, and the leaderboard need no account — only
 * `client.me()` failing outright (not just "not signed in", which resolves
 * to `null`) is worth showing an error for. */
async function refresh() {
  try {
    user = await client.me();
    renderShell();
  } catch (err) {
    el('testerBody').innerHTML = `<div class="status error">${escapeHtml(err.message)}</div>`;
  }
}

/* ============================ tabs ============================ */

function renderShell() {
  el('testerBody').innerHTML = `
    <div class="tabs" role="tablist">
      ${Object.entries(TABS)
        .map(
          ([key, label]) => `
        <button class="tab ${key === activeTab ? 'active' : ''}" role="tab"
          aria-selected="${key === activeTab}" data-tab="${key}">${escapeHtml(label)}</button>`,
        )
        .join('')}
    </div>
    <div id="testerTabPanel" role="tabpanel"></div>`;

  el('testerBody')
    .querySelectorAll('.tab')
    .forEach((btn) =>
      btn.addEventListener('click', () => {
        if (btn.dataset.tab === activeTab) return;
        activeTab = btn.dataset.tab;
        renderShell();
      }),
    );

  renderActiveTab();
}

function renderActiveTab() {
  renderGeneration += 1;
  if (activeTab === 'browse') renderBrowseTab();
  else if (activeTab === 'leaderboard') renderLeaderboardTab();
  else renderMineTab();
}

/* ============================ browse tab ============================ */

/**
 * The marketplace's home: a couple of curated grids and a leaderboard
 * teaser first — the same rhythm as a marketplace's own front page — then
 * the full filterable list underneath. The curated grids are a fixed
 * snapshot from the moment the tab opened; only the list below reacts to
 * the toolbar, the same way a homepage's highlights don't re-shuffle when
 * you filter the full directory below them.
 */
function renderBrowseTab() {
  el('testerTabPanel').innerHTML = `
    <div id="testerMarketplaceHighlights"></div>

    <h3>All listings</h3>
    <div class="toolbar">
      <div class="field">
        <label for="testerBrowseKind">Show</label>
        <select id="testerBrowseKind">
          <option value="">Everything</option>
          <option value="testing">Looking for testers</option>
          <option value="launch">Just launched / updated</option>
        </select>
      </div>
      <div class="field">
        <label for="testerBrowseSort">Sort by</label>
        <select id="testerBrowseSort">
          <option value="newest">Newest</option>
          <option value="contributors">Top contributors</option>
          <option value="emptiest">Needs testers most</option>
        </select>
      </div>
      <div class="field">
        <label>Platform</label>
        <span class="vchip-group" id="testerBrowsePlatform" role="group" aria-label="Filter by platform">
          <button type="button" class="vchip all${activePlatform ? '' : ' active'}" data-platform="">all</button>
          <button type="button" class="vchip ios${activePlatform === 'ios' ? ' active' : ''}" data-platform="ios">iOS</button>
          <button type="button" class="vchip android${activePlatform === 'android' ? ' active' : ''}" data-platform="android">Android</button>
          <button type="button" class="vchip both${activePlatform === 'both' ? ' active' : ''}" data-platform="both">Both</button>
        </span>
      </div>
      <button id="testerBrowseRefresh">Refresh</button>
    </div>
    <p class="verified-note">
      <span>◈</span>
      <span>Listing health, rating and last-shipped are recomputed from the public
      catalogue as you read — never entered by the developer who posted the listing.</span>
    </p>
    <div id="testerBrowseResults"></div>`;

  // Each of these starts a new independent pass over #testerBrowseResults,
  // so each bumps the shared generation itself — unlike the initial paint
  // below, where both halves are meant to share the tab switch's generation.
  const refreshList = () => {
    renderGeneration += 1;
    renderBrowse();
  };
  el('testerBrowseRefresh').addEventListener('click', refreshList);
  el('testerBrowseKind').addEventListener('change', refreshList);
  el('testerBrowseSort').addEventListener('change', refreshList);
  el('testerBrowsePlatform').querySelectorAll('.vchip').forEach((chip) => {
    chip.addEventListener('click', () => {
      el('testerBrowsePlatform').querySelectorAll('.vchip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      activePlatform = chip.dataset.platform || '';
      // Purely a client-side re-filter over the last fetch — no network
      // call, no spinner collapse, no layout jump (see `lastListings`'s
      // own comment).
      renderFilteredResults();
    });
  });

  renderMarketplaceHighlights();
  renderBrowse();
}

/** Fixed curation, computed once per tab visit: what's newest looking for
 * testers, what's newest just launched, and who's leading the leaderboard —
 * mirroring a marketplace home's "Recently listed" / "Best deals" rhythm
 * without literally scrolling carousels, and without re-fetching every time
 * the filterable list below changes. */
async function renderMarketplaceHighlights() {
  const generation = renderGeneration;
  const host = el('testerMarketplaceHighlights');
  host.innerHTML = '<div class="status"><span class="spinner"></span> Loading</div>';

  try {
    const [allListings, mine, board] = await Promise.all([
      client.browseListings(undefined, 'newest'),
      user ? client.mySessions() : Promise.resolve([]),
      client.leaderboard(),
    ]);
    if (generation !== renderGeneration) return;

    const requestedIds = new Set(mine.map((s) => s.listing.id));
    const testing = allListings.filter((l) => l.kind === 'testing').slice(0, 6);
    const launch = allListings.filter((l) => l.kind === 'launch').slice(0, 6);
    const topTesters = board.testers.slice(0, 5);

    host.innerHTML = [
      marketplaceSection('Looking for testers', testing, (l) => ({
        canRequest: true,
        alreadyRequested: requestedIds.has(l.id),
      })),
      marketplaceSection('Just launched / updated', launch, () => ({ canRequest: false })),
      leaderboardTeaser(topTesters, board.windowDays),
    ].join('');

    wireRequestButtons(host, [...testing, ...launch]);
    host.querySelector('.comm-view-leaderboard')?.addEventListener('click', () => {
      activeTab = 'leaderboard';
      renderShell();
    });
    enrichListings([...testing, ...launch], generation);
  } catch {
    // Decoration, not the point of the tab — the full list below still
    // works even if this curated pass fails, so it fails quietly.
    if (generation === renderGeneration) host.innerHTML = '';
  }
}

function marketplaceSection(title, listings, optsFor) {
  if (!listings.length) return '';
  return `
    <div class="marketplace-section">
      <h3>${escapeHtml(title)}</h3>
      <div class="marketplace-grid">
        ${listings.map((l) => marketplaceGridCard(l, optsFor(l))).join('')}
      </div>
    </div>`;
}

const MEDALS = ['🥇', '🥈', '🥉'];

/** The compact table a marketplace's own homepage teases its leaderboard
 * with — distinct from the full ranked `.board` on the Leaderboard tab,
 * which has room for a proportion bar per row. */
function leaderboardTeaser(entries, windowDays) {
  if (!entries.length) return '';
  return `
    <div class="marketplace-section">
      <div class="teaser-head">
        <h3>Top testers <span class="muted" style="font-weight:400;font-size:.78rem">last ${windowDays} days</span></h3>
        <button class="ghost comm-view-leaderboard" type="button">View full leaderboard →</button>
      </div>
      <div class="panel leaderboard-teaser">
        ${entries
          .map(
            (e) => `
          <div class="teaser-row">
            <span class="teaser-rank">${e.rank <= 3 ? MEDALS[e.rank - 1] : e.rank}</span>
            <span class="teaser-name">${escapeHtml(e.displayName)}</span>
            <span class="teaser-metric">${e.tokensEarned} <span class="unit">High Fives</span></span>
          </div>`,
          )
          .join('')}
      </div>
    </div>`;
}

/** Renders `#testerBrowseResults` from `lastListings`/`lastMine` (the last
 * successful fetch), applying `activePlatform` client-side — no network
 * call. Shared by the end of a real fetch (`renderBrowse`) and by a
 * platform-chip click, so both end up with identical markup/wiring. */
function renderFilteredResults() {
  const results = el('testerBrowseResults');
  const requestedIds = new Set(lastMine.map((s) => s.listing.id));
  const filtered = activePlatform ? lastListings.filter((l) => l.platform === activePlatform) : lastListings;
  results.innerHTML = filtered.length
    ? filtered
        .map((l) =>
          listingCard(l, {
            canRequest: l.kind === 'testing',
            alreadyRequested: requestedIds.has(l.id),
          }),
        )
        .join('')
    : empty('◍', 'Nothing here yet', 'Be the first to post a listing.');

  wireRequestButtons(results, filtered);
  enrichListings(filtered, renderGeneration);
}

async function renderBrowse() {
  // Captured, never bumped, here — `renderGeneration` is incremented exactly
  // where a new independent pass begins (a tab switch, or one of the toolbar
  // handlers above), so this and `renderMarketplaceHighlights` started by
  // the same tab switch share one generation instead of invalidating each
  // other.
  const generation = renderGeneration;
  const kind = el('testerBrowseKind').value || undefined;
  const sort = el('testerBrowseSort').value;
  const results = el('testerBrowseResults');

  // Only the very first load collapses the results to a spinner — once real
  // cards are on screen, a kind/sort refetch keeps them in place instead of
  // shrinking the page's height out from under the reader's scroll position
  // for the round trip.
  if (lastListings === null) {
    results.innerHTML = '<div class="status"><span class="spinner"></span> Loading</div>';
  }

  try {
    const [listings, mine] = await Promise.all([
      client.browseListings(kind, sort),
      user ? client.mySessions() : Promise.resolve([]),
    ]);
    if (generation !== renderGeneration) return;

    lastListings = listings;
    lastMine = mine;
    renderFilteredResults();
  } catch (err) {
    if (generation === renderGeneration) {
      results.innerHTML = `<div class="status error">${escapeHtml(err.message)}</div>`;
    }
  }
}

/** ` boost-1` through ` boost-7`, or empty — see the CSS comment on
 * `.listing-card.boost-1` in styles.css for what this does and, more
 * importantly, what it deliberately doesn't (change sort order). */
function boostClass(tier) {
  return tier ? ` boost-${tier}` : '';
}

/** Placeholder cells the enrichment pass fills in. Rendering them up front
 * rather than appending later keeps the card from reflowing under the
 * reader once the catalogue answers. */
function metricCell(label, id, value = '…', cls = 'pending', sub = '') {
  return `
    <div class="card-metric">
      <span class="metric-label">${escapeHtml(label)}</span>
      <span class="metric-value ${cls}" ${id ? `data-metric="${id}"` : ''}>${value}</span>
      ${sub ? `<span class="metric-sub">${escapeHtml(sub)}</span>` : ''}
    </div>`;
}

function listingCard(l, { canRequest = false, alreadyRequested = false } = {}) {
  const kindLabel = l.kind === 'testing' ? 'Closed testing' : 'Live on stores';
  const featured = l.featuredUntil && new Date(l.featuredUntil) > new Date();
  const action = !canRequest
    ? ''
    : alreadyRequested
      ? '<span class="pill neutral">Already requested</span>'
      : `<button class="primary comm-request" data-listing="${l.id}">Request to test</button>`;

  const slots =
    l.kind === 'testing'
      ? metricCell('Testers', null, `${l.slotsFilled}/${l.slotsWanted || '∞'}`, '')
      : '';

  // A `testing` listing's link never rides on this public, unauthenticated
  // response (community/routes/listings.js `serializeListing`) — only an
  // accepted-and-added tester sees it, through their own session. `l.link`
  // is only ever present here for a `launch` listing, so this must not
  // assume it exists.
  const linkCell = l.link
    ? `<div class="card-metric">
         <span class="metric-label">Link</span>
         <span class="metric-value" style="font-size:.85rem;font-weight:500">
           <a href="${escapeHtml(l.link)}" target="_blank" rel="noopener">Open ↗</a>
         </span>
       </div>`
    : l.kind === 'testing'
      ? `<div class="card-metric">
           <span class="metric-label">Link</span>
           <span class="metric-value" style="font-size:.85rem">🔒 Unlocks once accepted</span>
         </div>`
      : '';

  return `
    <div class="panel listing-card${boostClass(l.ownerBoostTier)}" data-card="${l.id}">
      <div class="listing-head">
        <span class="card-icon-wrap">${appIcon(l.app.artworkUrl, l.app.name)}${storeBadgeHtml(l.platform, 'bl')}</span>
        <div style="flex:1;min-width:0">
          <div class="listing-title">
            <strong>${escapeHtml(l.app.name)}</strong>
            <span class="pill ${l.kind === 'testing' ? 'warn' : 'ok'}">${kindLabel}</span>
            ${featured ? '<span class="pill warn">Featured</span>' : ''}
          </div>
          <div style="margin-top:.35rem;display:flex;gap:.3rem;flex-wrap:wrap">
            ${reliabilityBadge(l.ownerReliability)}
            ${contributionBadge(l.ownerContribution)}
          </div>
          ${l.description ? `<div class="listing-desc">${escapeHtml(l.description)}</div>` : ''}
        </div>
        ${action}
      </div>
      <div class="card-metrics">
        ${slots}
        ${metricCell('Listing health', `health-${l.id}`)}
        ${metricCell('Rating', `rating-${l.id}`)}
        ${metricCell('Last shipped', `shipped-${l.id}`)}
        ${linkCell}
      </div>
    </div>`;
}

/**
 * The compact vertical shape a marketplace's own front-page card uses —
 * icon, name, a fixed 3-column metric row — as opposed to `listingCard`'s
 * wide single-row layout built for a long filterable list. Reused for every
 * curated grid the marketplace home shows (looking-for-testers, launches,
 * a contributor's own apps), so those sections read as one visual family.
 */
function marketplaceGridCard(l, { canRequest = false, alreadyRequested = false } = {}) {
  const kindLabel = l.kind === 'testing' ? 'Closed testing' : 'Live on stores';
  const thirdMetric =
    l.kind === 'testing'
      ? { label: 'Testers', value: `${l.slotsFilled}/${l.slotsWanted || '∞'}` }
      : { label: 'Shipped', id: `shipped-${l.id}` };

  const action = !canRequest
    ? `<a class="ghost-link" href="${escapeHtml(l.link)}" target="_blank" rel="noopener">Open ↗</a>`
    : alreadyRequested
      ? '<span class="pill neutral">Already requested</span>'
      : `<button class="primary comm-request" data-listing="${l.id}" style="width:100%">Request to test</button>`;

  return `
    <div class="panel marketplace-card${boostClass(l.ownerBoostTier)}" data-card="${l.id}">
      <div class="marketplace-card-head">
        <span class="card-icon-wrap">${appIcon(l.app.artworkUrl, l.app.name)}${storeBadgeHtml(l.platform, 'bl')}</span>
        <div style="min-width:0;flex:1">
          <strong class="marketplace-card-name">${escapeHtml(l.app.name)}</strong>
          <div class="marketplace-card-badges">
            <span class="pill ${l.kind === 'testing' ? 'warn' : 'ok'}">${kindLabel}</span>
            ${reliabilityBadge(l.ownerReliability)}
          </div>
        </div>
      </div>
      <div class="marketplace-card-metrics">
        <div class="mini-metric">
          <span class="metric-label">Health</span>
          <span class="metric-value pending" data-metric="health-${l.id}">…</span>
        </div>
        <div class="mini-metric">
          <span class="metric-label">Rating</span>
          <span class="metric-value pending" data-metric="rating-${l.id}">…</span>
        </div>
        <div class="mini-metric">
          <span class="metric-label">${thirdMetric.label}</span>
          <span class="metric-value ${thirdMetric.id ? 'pending' : ''}" ${thirdMetric.id ? `data-metric="${thirdMetric.id}"` : ''}>
            ${thirdMetric.value ?? '…'}
          </span>
        </div>
      </div>
      ${action}
    </div>`;
}

/* ------------------ verified facts, filled in progressively ------------- */

function daysAgo(date) {
  if (!date) return null;
  return Math.floor((Date.now() - date.getTime()) / 86_400_000);
}

/** A listing can now appear twice at once — once in a curated showcase grid,
 * once in the full filterable list below it — so every match for this id
 * gets the update, not just the first `querySelector` would find. */
function setMetric(id, { text, tone = '', sub = '' }) {
  document.querySelectorAll(`[data-metric="${id}"]`).forEach((node) => {
    node.className = `metric-value ${tone}`;
    node.textContent = text;

    // A listing renders twice at once — once in a curated showcase card,
    // once in the full list below it — so this runs twice for the same id.
    // Reusing the existing `.metric-sub` rather than always appending a new
    // one is what keeps the second pass from stacking a duplicate
    // "144,659 ratings" under the first.
    let subNode = node.nextElementSibling?.classList.contains('metric-sub')
      ? node.nextElementSibling
      : null;
    if (sub) {
      if (!subNode) {
        subNode = document.createElement('span');
        subNode.className = 'metric-sub';
        node.after(subNode);
      }
      subNode.textContent = sub;
    } else {
      subNode?.remove();
    }
  });
}

/**
 * Walks the rendered cards and replaces each placeholder with a number
 * derived right here from the public catalogue. Deliberately sequential:
 * `ITunesClient` throttles anyway, and firing a dozen lookups at once would
 * only queue them behind each other while making failures harder to isolate.
 *
 * Every failure is per-card and silent — a listing whose app the catalogue
 * will not answer for still shows its community numbers, which are true.
 */
async function enrichListings(listings, generation) {
  if (!itunes) return;

  for (const listing of listings.slice(0, MAX_ENRICHED_CARDS)) {
    if (generation !== renderGeneration) return;
    if (!listing.app?.trackId) continue;

    try {
      const entry = await itunes.lookup(String(listing.app.trackId), {
        country: listing.app.country || 'us',
      });
      if (generation !== renderGeneration) return;
      if (!entry) {
        markUnavailable(listing.id);
        continue;
      }

      const report = checkAppHealth(profileFromEntry(entry));
      const { profile } = report;

      setMetric(`health-${listing.id}`, {
        text: `${Math.round(report.score)}/100`,
        tone: toneFor(report.score, [80, 50]),
      });

      setMetric(`rating-${listing.id}`, {
        text: profile.rating ? `${profile.rating.toFixed(1)}★` : 'No ratings',
        sub: profile.ratingCount ? `${profile.ratingCount.toLocaleString('en-US')} ratings` : '',
      });

      const days = daysAgo(profile.updated);
      setMetric(`shipped-${listing.id}`, {
        text: days === null ? 'Unknown' : days === 0 ? 'Today' : `${days}d ago`,
        tone: days === null ? '' : days > 180 ? 'warn' : '',
      });
    } catch {
      markUnavailable(listing.id);
    }
  }
}

function markUnavailable(listingId) {
  for (const key of ['health', 'rating', 'shipped']) {
    setMetric(`${key}-${listingId}`, { text: '—' });
  }
}

/* ============================ leaderboard tab ============================ */

async function renderLeaderboardTab() {
  const generation = renderGeneration;
  const panel = el('testerTabPanel');
  panel.innerHTML = '<div class="status"><span class="spinner"></span> Loading</div>';

  try {
    const { windowDays, testers, contributors } = await client.leaderboard();
    if (generation !== renderGeneration) return;

    panel.innerHTML = `
      <p class="lead">
        Ranked by High Fives earned over the last ${windowDays} days. A High Five exists
        only because a developer confirmed by hand that someone's testing actually helped —
        so the ranking recomputes itself, but nothing on it was ever self-awarded.
      </p>

      <h3>Top testers</h3>
      ${testersBoard(testers)}

      <h3>Apps from top contributors</h3>
      <p class="note">
        Developers who test other people's apps while recruiting for their own.
        Contributing is what surfaces a listing here — it can't be bought.
      </p>
      ${contributorsSection(contributors)}`;

    wireRequestButtons(panel, contributors.flatMap((c) => c.listings.map(asRequestable)));
    enrichListings(contributors.flatMap((c) => c.listings.map(asRequestable)), generation);
  } catch (err) {
    if (generation === renderGeneration) {
      panel.innerHTML = `<div class="status error">${escapeHtml(err.message)}</div>`;
    }
  }
}

/** Contributor listings arrive in a slimmer shape than `browse` returns;
 * this is the shared subset the request modal and enrichment both need. */
function asRequestable(listing) {
  return { ...listing, app: listing.app };
}

function testersBoard(entries) {
  if (!entries.length) {
    return empty(
      '◍',
      'No completed tests yet',
      'The first confirmed test session puts someone on the board.',
    );
  }

  const leader = entries[0].tokensEarned || 1;
  return `<div class="panel board">
    ${entries
      .map((e) => {
        const share = Math.round((e.tokensEarned / leader) * 100);
        return `
        <div class="board-row ${e.rank <= 3 ? 'top-3' : ''}">
          <span class="board-rank">${e.rank <= 3 ? MEDALS[e.rank - 1] : e.rank}</span>
          <span class="board-who">
            <div class="board-name">${escapeHtml(e.displayName)}</div>
            <div class="board-sub">${e.completedCount} test${e.completedCount === 1 ? '' : 's'} completed</div>
          </span>
          ${bar(share, toneFor(share, [66, 33]))}
          <span class="board-metric">${e.tokensEarned} <span class="unit">High Fives</span></span>
        </div>`;
      })
      .join('')}
  </div>`;
}

function contributorsSection(contributors) {
  const withListings = contributors.filter((c) => c.listings.length);
  if (!withListings.length) {
    return empty(
      '◍',
      'Nothing to show yet',
      'When someone who tests for others posts their own listing, it appears here.',
    );
  }

  return withListings
    .map(
      (c) => `
    <div class="panel contributor-group">
      <div class="contributor-head">
        <span class="board-rank">${c.rank <= 3 ? MEDALS[c.rank - 1] : c.rank}</span>
        <span style="flex:1;min-width:0">
          <div class="board-name">${escapeHtml(c.displayName)}</div>
          <div class="board-sub">
            ${c.completedCount} test${c.completedCount === 1 ? '' : 's'} given back to other developers
          </div>
        </span>
        <span class="board-metric">${c.tokensEarned} <span class="unit">High Fives</span></span>
      </div>
      <div class="contributor-listings">
        ${c.listings.map(contributorListingRow).join('')}
      </div>
    </div>`,
    )
    .join('');
}

function contributorListingRow(l) {
  const filled = l.slotsWanted ? Math.round((l.slotsFilled / l.slotsWanted) * 100) : 0;
  return `
    <div class="contributor-listing" data-card="${l.id}">
      <span class="card-icon-wrap">${appIcon(l.app.artworkUrl, l.app.name)}${storeBadgeHtml(l.platform, 'bl')}</span>
      <div class="contributor-listing-body">
        <div class="contributor-listing-name">${escapeHtml(l.app.name)}</div>
        <div class="board-sub">
          ${
            l.kind === 'testing'
              ? `${l.slotsFilled}/${l.slotsWanted || '∞'} testers`
              : 'Launched — open to new users'
          }
          · <span data-metric="health-${l.id}" class="pending">checking…</span>
        </div>
      </div>
      ${l.slotsWanted ? bar(filled, toneFor(100 - filled, [66, 33])) : ''}
      ${
        l.kind === 'testing'
          ? `<button class="primary comm-request" data-listing="${l.id}">Request to test</button>`
          : `<a href="${escapeHtml(l.link)}" target="_blank" rel="noopener">Open ↗</a>`
      }
    </div>`;
}

/* ============================ request modal ============================ */

function wireRequestButtons(container, listings) {
  container.querySelectorAll('.comm-request').forEach((btn) => {
    btn.addEventListener('click', () => {
      const listing = listings.find((l) => l.id === btn.dataset.listing);
      if (listing) openRequestModal(listing);
    });
  });
}

function openRequestModal(listing) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'commRequestModal';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="commReqTitle">
      <div class="modal-head">
        <div>
          <h3 id="commReqTitle">Request to test ${escapeHtml(listing.app.name)}</h3>
          <p class="modal-sub">The builder reviews every request — a short, specific pitch gets picked over a one-liner.</p>
        </div>
        <button class="modal-close" type="button" aria-label="Close">✕</button>
      </div>
      <div class="modal-fields">
        ${
          user
            ? ''
            : `<div class="field">
                 <label for="commReqName">Your name</label>
                 <input id="commReqName" type="text" placeholder="Jane Doe">
               </div>
               <div class="field">
                 <label for="commReqEmail">Your email</label>
                 <input id="commReqEmail" type="email" placeholder="you@example.com">
               </div>`
        }
        <div class="field">
          <label for="commReqMessage">Message</label>
          <textarea id="commReqMessage" rows="4"
            placeholder="Device/OS you'll test on, and why you're a good fit for this app."></textarea>
        </div>
      </div>
      <div id="commReqStatus" class="status"></div>
      <button id="commReqSubmit" class="primary" style="width:100%;margin-top:.5rem">Send request</button>
    </div>`;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
  overlay.querySelector('.modal-close').addEventListener('click', closeModal);
  document.addEventListener('keydown', onModalKeydown);
  el('commReqSubmit').addEventListener('click', () => submitRequest(listing));
  el('commReqMessage').focus();
}

function closeModal() {
  document.getElementById('commRequestModal')?.remove();
  document.removeEventListener('keydown', onModalKeydown);
}

function onModalKeydown(e) {
  if (e.key === 'Escape') closeModal();
}

async function submitRequest(listing) {
  const statusEl = el('commReqStatus');
  const message = el('commReqMessage').value.trim();

  if (message.length < MIN_MESSAGE_LENGTH) {
    statusEl.className = 'status error';
    statusEl.textContent = `Write a bit more — at least ${MIN_MESSAGE_LENGTH} characters about your device/OS and why you're a fit.`;
    return;
  }

  const body = { message };
  if (!user) {
    body.name = el('commReqName').value.trim();
    body.email = el('commReqEmail').value.trim();
    if (!body.name || !body.email) {
      statusEl.className = 'status error';
      statusEl.textContent = 'Name and email are required.';
      return;
    }
  }

  await withStatus(statusEl, el('commReqSubmit'), null, async () => {
    const result = await client.requestToJoin(listing.id, body);
    showRequestSuccess(result);
  });
}

function showRequestSuccess(result) {
  const modal = document.querySelector('#commRequestModal .modal');
  if (!modal) return;
  modal.innerHTML = `
    <div class="modal-head">
      <h3>Request sent</h3>
      <button class="modal-close" type="button" aria-label="Close">✕</button>
    </div>
    <p class="modal-sub">
      ${
        result.magicLinkSent
          ? 'The builder has your request. Check your email for a sign-in link so you can track it and submit feedback once accepted.'
          : 'The builder has your request — you\'ll see it under "My testing" once they respond.'
      }
    </p>
    <button id="commReqDone" class="primary" style="width:100%">Done</button>`;

  const done = () => {
    closeModal();
    renderActiveTab();
  };
  modal.querySelector('.modal-close').addEventListener('click', done);
  el('commReqDone').addEventListener('click', done);
}

/* ============================ my testing tab ============================ */

function renderMineTab() {
  if (!user) {
    el('testerTabPanel').innerHTML = empty(
      '◑',
      'Sign in to see your testing',
      'Request to test something on the Marketplace tab, or sign in from Get testers — the two pages share one account.',
    );
    return;
  }
  el('testerTabPanel').innerHTML = '<div id="testerSessions"></div>';
  // Delegated listeners, wired exactly once on this stable container — it
  // gets its `innerHTML` replaced on every re-render (a submitted review, a
  // fresh check-in) but the element itself never does, so wiring these
  // again on each re-render would stack a second listener on top of the
  // first rather than replacing it.
  wireDelegatedActions(el('testerSessions'));
  renderSessions();
}

async function renderSessions() {
  const container = el('testerSessions');
  container.innerHTML = '<div class="status"><span class="spinner"></span> Loading</div>';
  try {
    const sessions = await client.mySessions();
    if (!sessions.length) {
      container.innerHTML = empty(
        '◑',
        "You haven't requested to test anything yet",
        'Find something on the Marketplace tab.',
      );
      return;
    }
    container.innerHTML = (await Promise.all(sessions.map(sessionCard))).join('');
    wireSubmitButtons(container);
  } catch (err) {
    container.innerHTML = `<div class="status error">${escapeHtml(err.message)}</div>`;
  }
}

async function sessionCard(s) {
  const tone = STATUS_TONE[s.status] || 'neutral';
  const label = STATUS_LABEL[s.status] || s.status;

  let body = '';
  if (s.status === 'requested') {
    body = `<div class="muted" style="font-size:.82rem;margin-top:.3rem">"${escapeHtml(s.requestMessage)}"</div>`;
  } else if (s.status === 'accepted') {
    const checkins = await client.sessionCheckins(s.id).catch(() => []);
    // `s.listing.link` only rides along once `linkUnlocked` is true server-
    // side (community/routes/testSessions.js) — for a `testing` listing,
    // that means the developer has confirmed adding this tester on every
    // platform the listing targets (TestFlight and/or Play Console).
    const linkHtml = s.listing.link
      ? `<div style="margin-bottom:.5rem"><a class="ghost-link" href="${escapeHtml(s.listing.link)}" target="_blank" rel="noopener">Open build link →</a></div>`
      : `<p class="muted" style="font-size:.82rem">Waiting for the developer to add you on TestFlight/Play Console before the link unlocks.</p>`;
    body = `
      ${linkHtml}
      <div class="checkin-widget" data-session="${s.id}">
        ${checkinStripHtml(s.id, checkins, s.respondedAt)}
      </div>
      <div style="margin-top:.5rem">
        <textarea class="comm-feedback-input" data-session="${s.id}" rows="2"
          placeholder="What did you find? Bugs, confusing steps, first impressions..."
          style="width:100%"></textarea>
        <div class="eval-fields">
          <label><input type="checkbox" class="comm-bug-found" data-session="${s.id}"> Found a blocking bug</label>
          <label>Would use again:
            <select class="comm-would-use-again" data-session="${s.id}" style="width:auto">
              <option value="">—</option>
              <option value="yes">Yes</option>
              <option value="maybe">Maybe</option>
              <option value="no">No</option>
            </select>
          </label>
        </div>
        <button class="primary comm-submit" data-session="${s.id}">Submit feedback</button>
        <div class="comm-session-status status" data-session="${s.id}"></div>
      </div>`;
  } else if (s.status === 'submitted' || s.status === 'completed') {
    body = `<div class="muted" style="font-size:.82rem;margin-top:.3rem">"${escapeHtml(s.feedback ?? '')}"</div>`;
  }

  return `
    <div class="panel" style="padding:.9rem 1rem;margin-bottom:.6rem">
      <div style="display:flex;gap:.7rem;align-items:flex-start">
        ${appIcon(s.listing.artworkUrl, s.listing.appName)}
        <div style="flex:1;min-width:0">
          <strong>${escapeHtml(s.listing.appName)}</strong>
          <span class="pill ${tone}" style="margin-left:.4rem">${label}</span>
          ${body}
          ${s.status === 'completed' ? '<div class="muted" style="font-size:.78rem">+1 High Five awarded</div>' : ''}
          ${MESSAGEABLE_STATUSES.has(s.status) ? messageThreadHtml(s.id) : ''}
        </div>
      </div>
    </div>`;
}

/** The last `STRIP_DAYS` days (or fewer, if the test hasn't run that long
 * yet), oldest first, one dot each — done/missed/today, the same at-a-
 * glance shape as a habit tracker's own streak calendar. */
function checkinStripHtml(sessionId, checkins, acceptedAt) {
  const done = new Set(checkins.map((c) => c.date));
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const earliest = acceptedAt ? new Date(acceptedAt) : today;
  const start = new Date(Math.max(earliest.getTime(), today.getTime() - (STRIP_DAYS - 1) * 86_400_000));

  const days = [];
  for (let d = new Date(start.toISOString().slice(0, 10)); d <= today; d.setDate(d.getDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    days.push({ iso, done: done.has(iso), isToday: iso === todayIso });
  }

  const checkedInToday = done.has(todayIso);
  const streak = currentStreak(checkins, todayIso);

  return `
    <div class="checkin-strip-row">
      <div class="checkin-strip" id="checkin-strip-${sessionId}">
        ${days
          .map(
            (d) =>
              `<span class="checkin-day ${d.done ? 'done' : ''} ${d.isToday ? 'today' : ''}" title="${d.iso}${d.done ? ' — checked in' : ''}"></span>`,
          )
          .join('')}
      </div>
      <span class="muted" style="font-size:.76rem">${streak > 0 ? `${streak}-day streak` : 'No check-ins yet'}</span>
    </div>
    <label class="ghost checkin-upload-label ${checkedInToday ? 'disabled' : ''}">
      ${checkedInToday ? '✓ Checked in today' : '📷 Check in today'}
      <input type="file" accept="image/*" class="checkin-file-input" data-session="${sessionId}"
        data-accepted="${escapeHtml(acceptedAt ?? '')}" ${checkedInToday ? 'disabled' : ''} hidden>
    </label>
    <div class="checkin-status status" data-session="${sessionId}"></div>`;
}

/** Consecutive days ending today (or yesterday, if today's check-in just
 * hasn't happened yet — a streak isn't broken until a day is actually
 * missed, and the day isn't over). */
function currentStreak(checkins, todayIso) {
  const done = new Set(checkins.map((c) => c.date));
  let cursor = done.has(todayIso) ? new Date(todayIso) : new Date(Date.now() - 86_400_000);
  let streak = 0;
  while (done.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor = new Date(cursor.getTime() - 86_400_000);
  }
  return streak;
}

/** Downscales and re-encodes client-side so a phone's multi-MB screenshot
 * becomes a data URL comfortably under the server's MAX_CHECKIN_PHOTO_CHARS
 * — proof doesn't need to be full resolution, just legible. */
function compressPhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That does not look like an image.'));
      img.onload = () => {
        const scale = Math.min(1, MAX_PHOTO_DIMENSION / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', PHOTO_QUALITY));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/** Delegated listeners — wired exactly once (see the call site in
 * `renderMineTab`), so they never need re-wiring as the container's content
 * changes underneath them. */
function wireDelegatedActions(container) {
  wireMessageThreads(container);

  // `submitCheckin` replaces just the one widget it touched rather than the
  // whole list, so this — unlike `wireSubmitButtons` below — has to be
  // delegated: an input wired individually would need re-wiring after every
  // check-in and risk a second listener stacking onto everything that
  // didn't change.
  container.addEventListener('change', (e) => {
    const input = e.target.closest('.checkin-file-input');
    if (input && container.contains(input)) submitCheckin(container, input);
  });
}

/** Per-button — safe to call after every full re-render (`renderSessions`
 * replaces the container's entire `innerHTML`, so these are always fresh
 * elements, never already-wired ones). */
function wireSubmitButtons(container) {
  container.querySelectorAll('.comm-submit').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.session;
      const textarea = container.querySelector(`.comm-feedback-input[data-session="${id}"]`);
      const statusEl = container.querySelector(`.comm-session-status[data-session="${id}"]`);
      const feedback = textarea.value.trim();
      if (!feedback) {
        if (statusEl) {
          statusEl.className = 'comm-session-status status error';
          statusEl.textContent = 'Write a few words about what you found first.';
        }
        return;
      }
      const bugFoundEl = container.querySelector(`.comm-bug-found[data-session="${id}"]`);
      const wouldUseAgainEl = container.querySelector(`.comm-would-use-again[data-session="${id}"]`);
      btn.disabled = true;
      try {
        await client.submitSession(id, {
          feedback,
          bugFound: bugFoundEl?.checked ?? false,
          wouldUseAgain: wouldUseAgainEl?.value || undefined,
        });
        await renderSessions();
      } catch (err) {
        btn.disabled = false;
        if (statusEl) {
          statusEl.className = 'comm-session-status status error';
          statusEl.textContent = err.message;
        }
      }
    });
  });
}

async function submitCheckin(container, input) {
  const file = input.files[0];
  if (!file) return;
  const id = input.dataset.session;
  const acceptedAt = input.dataset.accepted;
  const statusEl = container.querySelector(`.checkin-status[data-session="${id}"]`);

  if (file.size > MAX_SOURCE_FILE_BYTES) {
    statusEl.className = 'checkin-status status error';
    statusEl.textContent = 'That file is too large — pick a screenshot, not a video or a RAW photo.';
    input.value = '';
    return;
  }

  statusEl.className = 'checkin-status status';
  statusEl.innerHTML = '<span class="spinner"></span> Uploading';
  try {
    const photo = await compressPhoto(file);
    const date = new Date().toISOString().slice(0, 10);
    await client.submitCheckin(id, { date, photo });
    statusEl.className = 'checkin-status status';
    statusEl.textContent = '';

    const checkins = await client.sessionCheckins(id);
    const widget = container.querySelector(`.checkin-widget[data-session="${id}"]`);
    if (widget) {
      widget.outerHTML = `<div class="checkin-widget" data-session="${id}">${checkinStripHtml(id, checkins, acceptedAt)}</div>`;
    }
  } catch (err) {
    statusEl.className = 'checkin-status status error';
    statusEl.textContent = err.message;
  } finally {
    input.value = '';
  }
}
