/**
 * Get real testers before you ship, real users at launch.
 *
 * Three jobs live here — a marketplace, a ranking, and your own dashboard —
 * so this is the one view in the app with tabs rather than one long scroll.
 *
 * Two ideas hold the feature together:
 *
 * Browsing, requesting to test and the leaderboard need no account; only
 * posting or managing a listing does. Requesting to join a `testing`
 * listing is a short reviewed pitch, not an instant join, and the owner
 * accepts or declines before it becomes an active test.
 *
 * And every headline number on a listing card is *recomputed here* from the
 * public catalogue when you look at it — the same engines the rest of this
 * app runs on (`lib/app-profile.js`) — never a figure the person who posted
 * the listing typed in. That is what makes a card worth trusting, and it is
 * why the tools half of this app and the community half are one product
 * rather than two sharing a sidebar.
 *
 * See `community/README.md` for the design rationale — in particular why
 * none of this ever touches App Store/Play reviews or ratings.
 */

import { el, escapeHtml, empty, withStatus, appIcon, bar, toneFor, ring, showToast } from './shared.js';
import { checkAppHealth, profileFromEntry } from '../lib/app-profile.js';
import { enablePush, listenForInAppToasts, pushPermissionState, pushSupported } from '../lib/push.js';

const MIN_MESSAGE_LENGTH = 20;

/** Catalogue lookups are throttled to protect Apple's endpoint, so a page of
 * cards enriches over a noticeable stretch of time. Capping keeps that from
 * running for minutes on a long list — the rows below the fold simply keep
 * their community-only numbers, which are still true. */
const MAX_ENRICHED_CARDS = 12;

const TABS = {
  browse: 'Marketplace',
  inbox: 'Inbox',
  mine: 'Your testing',
  leaderboard: 'Leaderboard',
};

let client = null;
let itunes = null;
let getCurrentApp = null;
let user = null;
let activeTab = 'browse';

/** Bumped on every tab switch or re-render. The progressive enrichment loop
 * carries the value it started with and stops the moment it no longer
 * matches, so a stale pass can never write into a page it no longer owns. */
let renderGeneration = 0;

export function initCommunity(communityClient, { getCurrentApp: getApp, itunes: itunesClient } = {}) {
  client = communityClient;
  getCurrentApp = getApp || (() => null);
  itunes = itunesClient ?? null;

  const navItem = document.querySelector('.nav-item[href="#community"]');

  if (!client.configured) {
    navItem?.classList.add('hidden');
    el('commBody').innerHTML = empty(
      '◍',
      'Not set up yet',
      'This deployment has no community backend configured. See community/README.md.',
    );
    return;
  }

  // Registered once, independent of which tab is open — a push can arrive
  // while the user is looking at Screenshots or Rank, not just Inbox.
  listenForInAppToasts(({ title, body }) => {
    showToast({
      title,
      body,
      onClick: () => {
        location.hash = '#community';
        if (activeTab !== 'inbox') {
          activeTab = 'inbox';
          renderShell();
        }
      },
    });
  });

  refreshSession();
}

async function refreshSession() {
  try {
    user = await client.me();
    renderAll();
  } catch (err) {
    el('commBody').innerHTML = `<div class="status error">${escapeHtml(err.message)}</div>`;
  }
}

function renderAll() {
  renderAuthBar();
  renderShell();
}

/* ============================ auth bar ============================ */

function renderAuthBar() {
  const authBar = el('commAuthBar');
  if (user) {
    authBar.innerHTML = `
      <div class="summary pass" style="margin-bottom:1.2rem">
        <span class="verdict">Signed in as ${escapeHtml(user.email)}</span>
        <span class="muted">${user.tokenBalance} token${user.tokenBalance === 1 ? '' : 's'}</span>
        <button id="commLogout" class="ghost" style="margin-left:auto">Sign out</button>
      </div>`;
    el('commLogout').addEventListener('click', async () => {
      await client.logout();
      user = null;
      renderAll();
    });
    return;
  }

  authBar.innerHTML = `
    <div class="toolbar" style="margin-bottom:1.2rem">
      <div class="field" style="flex:1;min-width:14rem">
        <label for="commEmail">Already have an account?</label>
        <input id="commEmail" type="email" placeholder="you@example.com">
      </div>
      <button id="commSendLink">Send sign-in link</button>
    </div>
    <div id="commAuthStatus" class="status"></div>`;
  el('commSendLink').addEventListener('click', sendLink);
  el('commEmail').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendLink();
  });
}

async function sendLink() {
  const email = el('commEmail').value.trim();
  if (!email) return;

  await withStatus(el('commAuthStatus'), el('commSendLink'), null, async (say) => {
    say('Sending link');
    await client.requestLink(email);
    el('commAuthStatus').className = 'status';
    el('commAuthStatus').innerHTML =
      `<span class="muted">Check <strong>${escapeHtml(email)}</strong> for a sign-in link. ` +
      'It expires in 15 minutes.</span>';
  });
}

/* ============================ tabs ============================ */

function renderShell() {
  el('commBody').innerHTML = `
    <div class="tabs" role="tablist">
      ${Object.entries(TABS)
        .map(
          ([key, label]) => `
        <button class="tab ${key === activeTab ? 'active' : ''}" role="tab"
          aria-selected="${key === activeTab}" data-tab="${key}">${escapeHtml(label)}</button>`,
        )
        .join('')}
    </div>
    <div id="commTabPanel" role="tabpanel"></div>`;

  el('commBody')
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
  else if (activeTab === 'inbox') renderInboxTab();
  else renderYourTestingTab();
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
  el('commTabPanel').innerHTML = `
    <div id="commMarketplaceHighlights"></div>

    <h3>All listings</h3>
    <div class="toolbar">
      <div class="field">
        <label for="commBrowseKind">Show</label>
        <select id="commBrowseKind">
          <option value="">Everything</option>
          <option value="testing">Looking for testers</option>
          <option value="launch">Just launched / updated</option>
        </select>
      </div>
      <div class="field">
        <label for="commBrowseSort">Sort by</label>
        <select id="commBrowseSort">
          <option value="newest">Newest</option>
          <option value="contributors">Top contributors</option>
          <option value="emptiest">Needs testers most</option>
        </select>
      </div>
      <button id="commBrowseRefresh">Refresh</button>
    </div>
    <p class="verified-note">
      <span>◈</span>
      <span>Listing health, rating and last-shipped are recomputed from the public
      catalogue as you read — never entered by the developer who posted the listing.</span>
    </p>
    <div id="commBrowseResults"></div>`;

  // Each of these starts a new independent pass over #commBrowseResults, so
  // each bumps the shared generation itself — unlike the initial paint
  // below, where both halves are meant to share the tab switch's generation.
  const refresh = () => {
    renderGeneration += 1;
    renderBrowse();
  };
  el('commBrowseRefresh').addEventListener('click', refresh);
  el('commBrowseKind').addEventListener('change', refresh);
  el('commBrowseSort').addEventListener('change', refresh);

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
  const host = el('commMarketplaceHighlights');
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

/** The compact table TrustMRR's own homepage teases its leaderboard with —
 * distinct from the full ranked `.board` on the Leaderboard tab, which has
 * room for a proportion bar per row. */
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
            <span class="teaser-metric">${e.tokensEarned} <span class="unit">tokens</span></span>
          </div>`,
          )
          .join('')}
      </div>
    </div>`;
}

async function renderBrowse() {
  // Captured, never bumped, here — `renderGeneration` is incremented exactly
  // where a new independent pass begins (a tab switch, or one of the toolbar
  // handlers below), so this and `renderMarketplaceHighlights` started by the
  // same tab switch share one generation instead of invalidating each other.
  const generation = renderGeneration;
  const results = el('commBrowseResults');
  results.innerHTML = '<div class="status"><span class="spinner"></span> Loading</div>';

  try {
    const [listings, mine] = await Promise.all([
      client.browseListings(el('commBrowseKind').value || undefined, el('commBrowseSort').value),
      user ? client.mySessions() : Promise.resolve([]),
    ]);
    if (generation !== renderGeneration) return;

    const requestedIds = new Set(mine.map((s) => s.listing.id));
    results.innerHTML = listings.length
      ? listings
          .map((l) =>
            listingCard(l, {
              canRequest: l.kind === 'testing',
              alreadyRequested: requestedIds.has(l.id),
            }),
          )
          .join('')
      : empty('◍', 'Nothing here yet', 'Be the first to post a listing.');

    wireRequestButtons(results, listings);
    enrichListings(listings, generation);
  } catch (err) {
    if (generation === renderGeneration) {
      results.innerHTML = `<div class="status error">${escapeHtml(err.message)}</div>`;
    }
  }
}

function reliabilityBadge(rep) {
  if (!rep || rep.isNew) return '<span class="pill neutral">New builder</span>';
  const tone = rep.completionRate >= 70 ? 'ok' : rep.completionRate >= 40 ? 'warn' : 'bad';
  const resp =
    rep.avgResponseHours == null
      ? ''
      : rep.avgResponseHours < 24
        ? ` · replies in ~${Math.max(1, Math.round(rep.avgResponseHours))}h`
        : ` · replies in ~${Math.round(rep.avgResponseHours / 24)}d`;
  return `<span class="pill ${tone}">${rep.completionRate}% completion${resp}</span>`;
}

function contributionBadge(count) {
  if (!count) return '';
  return `<span class="pill info" title="Tests this developer completed for other people's apps">
    ${count} test${count === 1 ? '' : 's'} given back</span>`;
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
  const kindLabel = l.kind === 'testing' ? 'Looking for testers' : 'Launch / update';
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

  return `
    <div class="panel listing-card" data-card="${l.id}">
      <div class="listing-head">
        ${appIcon(l.app.artworkUrl, l.app.name)}
        <div style="flex:1;min-width:0">
          <div class="listing-title">
            <strong>${escapeHtml(l.app.name)}</strong>
            <span class="pill ${l.kind === 'testing' ? 'info' : 'ok'}">${kindLabel}</span>
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
        <div class="card-metric">
          <span class="metric-label">Link</span>
          <span class="metric-value" style="font-size:.85rem;font-weight:500">
            <a href="${escapeHtml(l.link)}" target="_blank" rel="noopener">Open ↗</a>
          </span>
        </div>
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
  const kindLabel = l.kind === 'testing' ? 'Looking for testers' : 'Launch / update';
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
    <div class="panel marketplace-card" data-card="${l.id}">
      <div class="marketplace-card-head">
        ${appIcon(l.app.artworkUrl, l.app.name)}
        <div style="min-width:0;flex:1">
          <strong class="marketplace-card-name">${escapeHtml(l.app.name)}</strong>
          <div class="marketplace-card-badges">
            <span class="pill ${l.kind === 'testing' ? 'info' : 'ok'}">${kindLabel}</span>
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
  const panel = el('commTabPanel');
  panel.innerHTML = '<div class="status"><span class="spinner"></span> Loading</div>';

  try {
    const { windowDays, testers, contributors } = await client.leaderboard();
    if (generation !== renderGeneration) return;

    panel.innerHTML = `
      <p class="lead">
        Ranked by tokens earned over the last ${windowDays} days. A token exists only
        because a developer confirmed by hand that someone's testing actually helped —
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
          <span class="board-metric">${e.tokensEarned} <span class="unit">tokens</span></span>
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
        <span class="board-metric">${c.tokensEarned} <span class="unit">tokens</span></span>
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
      ${appIcon(l.app.artworkUrl, l.app.name)}
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
          : "The builder has your request — you'll see it under \"Your testing\" once they respond."
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

/* ============================ your testing tab ============================ */

function renderYourTestingTab() {
  if (!user) {
    el('commTabPanel').innerHTML = empty(
      '◍',
      'Sign in to manage your testing',
      'Use the box above — browsing and requesting to test need no account, only posting does.',
    );
    return;
  }

  el('commTabPanel').innerHTML = `
    <div id="commDashboardStats"></div>
    <div id="commAsoBridge"></div>

    <h3>Get testers or announce a launch</h3>
    <div id="commCreatePanel"></div>

    <h3>Your listings</h3>
    <div id="commMyListings"></div>

    <h3>Apps you're testing</h3>
    <div id="commMySessions"></div>`;

  renderDashboardStats();
  renderAsoBridge();
  renderCreatePanel();
  renderMyListings();
  renderMySessions();
}

/** Three cheap numbers up top — the difference between a page that manages
 * a list and one that reads as a dashboard. Deliberately not "pending
 * requests": that count is already visible inline under each listing below,
 * and computing it here would mean one extra fetch per listing. */
async function renderDashboardStats() {
  const host = el('commDashboardStats');
  if (!host) return;
  try {
    const [listings, sessions] = await Promise.all([client.myListings(), client.mySessions()]);
    const activeListings = listings.filter((l) => l.status === 'open').length;
    const testingNow = sessions.filter((s) => s.status === 'accepted' || s.status === 'submitted').length;

    host.innerHTML = `
      <div class="dashboard-stats">
        <div class="dashboard-stat">
          <span class="metric-label">Tokens</span>
          <span class="dashboard-stat-value">${user.tokenBalance}</span>
        </div>
        <div class="dashboard-stat">
          <span class="metric-label">Active listings</span>
          <span class="dashboard-stat-value">${activeListings}</span>
        </div>
        <div class="dashboard-stat">
          <span class="metric-label">Testing right now</span>
          <span class="dashboard-stat-value">${testingNow}</span>
        </div>
      </div>`;
  } catch {
    host.innerHTML = '';
  }
}

/**
 * The bridge between the two halves of the product: the same listing-health
 * engine Overview runs (`lib/app-profile.js`), reused here so a builder sees
 * exactly what a tester would find suspect *before* they post a listing —
 * not a separate scoring system, the same one, just surfaced where the
 * decision to finalize is actually being made. Shown whenever an app is
 * connected, whether or not it has a listing yet.
 */
async function renderAsoBridge() {
  const host = el('commAsoBridge');
  if (!host) return;
  const app = getCurrentApp();
  if (!app || !itunes) {
    host.innerHTML = '';
    return;
  }

  host.innerHTML = '<div class="status"><span class="spinner"></span> Checking your listing</div>';
  try {
    const entry = await itunes.lookup(String(app.trackId), { country: app.country || 'us' });
    if (!entry) {
      host.innerHTML = '';
      return;
    }

    const report = checkAppHealth(profileFromEntry(entry));
    const topIssues = report.failing.slice(0, 3);

    host.innerHTML = `
      <div class="panel aso-bridge">
        <div class="aso-bridge-head">
          ${appIcon(app.artwork, app.name)}
          <div style="flex:1;min-width:0">
            <strong>Finalize ${escapeHtml(app.name)}'s launch</strong>
            <div class="muted" style="font-size:.82rem">
              The same listing health Overview computes — fix it there, testers see it here.
            </div>
          </div>
          ${ring(report.score, { size: 52, stroke: 4, thresholds: [80, 50] })}
        </div>
        ${
          topIssues.length
            ? `<ul class="aso-bridge-issues">
                 ${topIssues.map((c) => `<li>${escapeHtml(c.label)}</li>`).join('')}
               </ul>
               <a class="ghost-link" href="#overview">Open Overview to fix →</a>`
            : '<p class="muted" style="font-size:.85rem;margin:.6rem 0 0">Nothing failing — your listing is ready to post.</p>'
        }
      </div>`;
  } catch {
    host.innerHTML = '';
  }
}

function renderCreatePanel() {
  const app = getCurrentApp();
  if (!app) {
    el('commCreatePanel').innerHTML =
      '<p class="note">Load an app on the Overview page first — a listing reuses its name, ' +
      'icon and store link rather than asking you to retype them.</p>';
    return;
  }

  el('commCreatePanel').innerHTML = `
    <div class="app-header" style="margin-bottom:.8rem">
      ${appIcon(app.artwork, app.name)}
      <div class="app-header-body">
        <strong>${escapeHtml(app.name)}</strong>
        <div class="muted">${escapeHtml(app.seller || '')}</div>
      </div>
    </div>
    <div class="form-grid">
      <label for="commKind">This listing is</label>
      <select id="commKind">
        <option value="testing">Looking for closed testers (not out yet)</option>
        <option value="launch">A launch or update (already out)</option>
      </select>
      <label for="commPlatform">Platform</label>
      <select id="commPlatform">
        <option value="ios">iOS</option>
        <option value="android">Android</option>
        <option value="both">Both</option>
      </select>
      <label for="commLink">Link</label>
      <input id="commLink" type="text"
        placeholder="TestFlight/Play testing link, or the store listing once it's out">
      <label for="commSlots">Testers wanted</label>
      <input id="commSlots" type="number" min="0" max="100" value="10" style="width:6rem">
      <label for="commDescription">What should they know</label>
      <textarea id="commDescription" rows="3"
        placeholder="What to focus feedback on, or what's new in this release"></textarea>
    </div>
    <div id="commCreateStatus" class="status"></div>
    <button id="commCreateSubmit" class="primary">Post listing</button>`;

  el('commCreateSubmit').addEventListener('click', () => createListing(app));
}

async function createListing(app) {
  await withStatus(el('commCreateStatus'), el('commCreateSubmit'), null, async (say) => {
    say('Connecting your app');
    const { app: connected } = await client.connectApp({
      trackId: app.trackId,
      bundleId: app.bundleId,
      name: app.name,
      artworkUrl: app.artwork,
      storeUrl: app.storeUrl,
      country: app.country,
    });

    say('Posting listing');
    await client.createListing({
      appId: connected.id,
      kind: el('commKind').value,
      platform: el('commPlatform').value,
      link: el('commLink').value.trim(),
      description: el('commDescription').value.trim(),
      slotsWanted: Number(el('commSlots').value) || 0,
    });

    el('commLink').value = '';
    el('commDescription').value = '';
    await renderMyListings();
  });
}

async function renderMyListings() {
  const container = el('commMyListings');
  if (!container) return;
  container.innerHTML = '<div class="status"><span class="spinner"></span> Loading</div>';
  try {
    const listings = await client.myListings();
    if (!listings.length) {
      container.innerHTML = empty('◍', 'No listings yet', 'Post one above.');
      return;
    }
    container.innerHTML = (await Promise.all(listings.map((l) => myListingCard(l)))).join('');
    wireMyListingActions(container);
  } catch (err) {
    container.innerHTML = `<div class="status error">${escapeHtml(err.message)}</div>`;
  }
}

async function myListingCard(l) {
  const sessions = l.status === 'open' ? await client.listingSessions(l.id) : [];
  const pending = sessions.filter((s) => s.status === 'requested');
  const active = sessions.filter((s) => s.status !== 'requested');

  const activeHtml = active.length
    ? active.map(sessionRow).join('')
    : pending.length
      ? ''
      : '<p class="muted" style="font-size:.82rem">No testers have joined yet.</p>';

  return `
    <div class="panel" style="padding:.9rem 1rem;margin-bottom:.6rem">
      ${listingCardHeader(l)}
      ${
        pending.length
          ? `<div style="margin-top:.7rem">
               <strong style="font-size:.82rem">Requests to review (${pending.length})</strong>
               ${pending.map(requestCard).join('')}
             </div>`
          : ''
      }
      <div style="margin-top:.6rem">${activeHtml}</div>
      <div style="margin-top:.6rem;display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
        ${
          l.status === 'open'
            ? `<span style="display:flex;gap:.3rem;align-items:center">
                 <input type="number" class="comm-feature-days" data-listing="${l.id}"
                   value="3" min="1" max="14" style="width:4rem">
                 <button class="comm-feature" data-listing="${l.id}">Feature (3 tokens/day)</button>
               </span>
               <button class="ghost comm-close" data-listing="${l.id}">Close listing</button>`
            : '<span class="pill neutral">Closed</span>'
        }
      </div>
      <div class="comm-listing-status status" data-listing="${l.id}"></div>
    </div>`;
}

function requestCard(s) {
  const rep =
    s.testerCompletedCount > 0
      ? `<span class="pill ok" style="margin-left:.4rem">${s.testerCompletedCount} test${s.testerCompletedCount === 1 ? '' : 's'} completed</span>`
      : '<span class="pill neutral" style="margin-left:.4rem">New tester</span>';
  return `
    <div class="request-card">
      <div class="request-head">
        <span class="request-who">${escapeHtml(s.testerDisplayName || s.testerEmail)}${rep}</span>
      </div>
      <div class="request-message">"${escapeHtml(s.requestMessage)}"</div>
      <div class="request-actions">
        <button class="primary comm-accept" data-session="${s.id}">Accept</button>
        <button class="ghost comm-decline" data-session="${s.id}">Decline</button>
      </div>
    </div>`;
}

function sessionRow(s) {
  const evalBadges = [];
  if (s.bugFound !== null) {
    evalBadges.push(
      `<span class="pill ${s.bugFound ? 'warn' : 'ok'}">${s.bugFound ? 'Bug found' : 'No bugs'}</span>`,
    );
  }
  if (s.wouldUseAgain) {
    evalBadges.push(`<span class="pill neutral">Would use again: ${escapeHtml(s.wouldUseAgain)}</span>`);
  }
  return `
    <div style="padding:.4rem 0;border-top:1px solid var(--border)">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:.6rem">
        <div style="min-width:0">
          <span class="mono" style="font-size:.8rem">${escapeHtml(s.testerDisplayName || s.testerEmail)}</span>
          <span class="pill neutral" style="margin-left:.4rem">${s.status}</span>
          ${evalBadges.length ? `<div class="eval-summary">${evalBadges.join('')}</div>` : ''}
          ${s.feedback ? `<div class="muted" style="font-size:.82rem;margin-top:.2rem">"${escapeHtml(s.feedback)}"</div>` : ''}
        </div>
        ${
          s.status === 'submitted'
            ? `<button class="comm-complete" data-session="${s.id}">Mark complete</button>`
            : ''
        }
      </div>
      ${MESSAGEABLE_STATUSES.has(s.status) ? messageThreadHtml(s.id) : ''}
    </div>`;
}

function listingCardHeader(l) {
  const kindLabel = l.kind === 'testing' ? 'Looking for testers' : 'Launch / update';
  return `
    <div style="display:flex;gap:.7rem;align-items:flex-start">
      ${appIcon(l.app.artworkUrl, l.app.name)}
      <div>
        <strong>${escapeHtml(l.app.name)}</strong>
        <span class="pill ${l.kind === 'testing' ? 'info' : 'ok'}" style="margin-left:.4rem">${kindLabel}</span>
        <div class="muted" style="font-size:.82rem">${escapeHtml(l.description || '')}</div>
      </div>
    </div>`;
}

function showListingError(container, listingId, message) {
  const statusEl = container.querySelector(`.comm-listing-status[data-listing="${listingId}"]`);
  if (statusEl) {
    statusEl.className = 'comm-listing-status status error';
    statusEl.textContent = message;
  }
}

/** One handler shape for every per-session button: disable, call, re-render,
 * and put the failure where the user was already looking if it throws. */
function wireSessionAction(container, selector, call) {
  container.querySelectorAll(selector).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const statusEl = btn.closest('.panel')?.querySelector('.comm-listing-status');
      btn.disabled = true;
      try {
        await call(btn);
        await renderMyListings();
      } catch (err) {
        btn.disabled = false;
        if (statusEl) {
          statusEl.className = 'comm-listing-status status error';
          statusEl.textContent = err.message;
        }
      }
    });
  });
}

function wireMyListingActions(container) {
  wireSessionAction(container, '.comm-accept', (btn) => client.acceptSession(btn.dataset.session));
  wireSessionAction(container, '.comm-decline', (btn) => client.declineSession(btn.dataset.session));
  wireSessionAction(container, '.comm-complete', (btn) => client.completeSession(btn.dataset.session));
  wireSessionAction(container, '.comm-close', (btn) => client.closeListing(btn.dataset.listing));
  wireMessageThreads(container);

  container.querySelectorAll('.comm-feature').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const listingId = btn.dataset.listing;
      const daysInput = container.querySelector(`.comm-feature-days[data-listing="${listingId}"]`);
      const days = Number(daysInput?.value);
      if (!Number.isInteger(days) || days < 1 || days > 14) {
        showListingError(container, listingId, 'Enter a number of days between 1 and 14.');
        return;
      }
      btn.disabled = true;
      try {
        await client.featureListing(listingId, days);
        user = { ...user, tokenBalance: user.tokenBalance - days * 3 };
        renderAuthBar();
        await renderMyListings();
      } catch (err) {
        btn.disabled = false;
        showListingError(container, listingId, err.message);
      }
    });
  });
}

/* ---------------------------- your sessions ---------------------------- */

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

/* ---------------------------- message threads ---------------------------- */

// Only once a request has been accepted is there anything to coordinate —
// a device the tester doesn't have, a build that needs a fresh TestFlight
// invite. Before that the pitch (`requestMessage`) already says everything
// there is to say, and after `declined`/`abandoned` there is nothing left
// to arrange, so neither status gets a thread.
const MESSAGEABLE_STATUSES = new Set(['accepted', 'submitted', 'completed']);

function messageThreadHtml(sessionId) {
  return `
    <div style="margin-top:.4rem">
      <button class="ghost comm-thread-toggle" data-session="${sessionId}" type="button">Messages</button>
      <div class="comm-thread" data-session="${sessionId}" hidden></div>
    </div>`;
}

/** Delegates once per container rather than once per toggle button, so a
 * card list that re-renders (a new session appearing, one changing status)
 * never needs its listeners rewired by hand. */
function wireMessageThreads(container) {
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.comm-thread-toggle');
    if (btn && container.contains(btn)) toggleThread(btn);
  });
}

async function toggleThread(btn) {
  const id = btn.dataset.session;
  const thread = document.querySelector(`.comm-thread[data-session="${id}"]`);
  if (!thread) return;
  const opening = thread.hidden;
  thread.hidden = !opening;
  if (opening && !thread.dataset.loaded) {
    thread.dataset.loaded = '1';
    await loadThread(id, thread);
  }
}

async function loadThread(id, thread) {
  thread.innerHTML = '<div class="status"><span class="spinner"></span> Loading</div>';
  try {
    renderThread(id, thread, await client.sessionMessages(id));
  } catch (err) {
    thread.innerHTML = `<div class="status error">${escapeHtml(err.message)}</div>`;
  }
}

function renderThread(id, thread, messages) {
  const list = messages.length
    ? messages
        .map(
          (m) => `
        <div class="thread-message${m.senderUserId === user?.id ? ' mine' : ''}">
          <div class="muted" style="font-size:.72rem">${escapeHtml(new Date(m.createdAt).toLocaleString())}</div>
          <div>${escapeHtml(m.body)}</div>
        </div>`,
        )
        .join('')
    : '<p class="muted" style="font-size:.8rem">No messages yet.</p>';

  thread.innerHTML = `
    <div class="thread-list">${list}</div>
    <div style="display:flex;gap:.4rem;margin-top:.5rem">
      <input type="text" class="comm-thread-input" placeholder="Write a message…" style="flex:1">
      <button class="comm-thread-send">Send</button>
    </div>
    <div class="comm-thread-status status"></div>`;

  const input = thread.querySelector('.comm-thread-input');
  const sendBtn = thread.querySelector('.comm-thread-send');
  const statusEl = thread.querySelector('.comm-thread-status');

  const sendMessage = async () => {
    const body = input.value.trim();
    if (!body) return;
    sendBtn.disabled = true;
    statusEl.textContent = '';
    try {
      await client.sendSessionMessage(id, body);
      input.value = '';
      renderThread(id, thread, await client.sessionMessages(id));
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = err.message;
      sendBtn.disabled = false;
    }
  };
  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage();
  });
}

/* ------------------------------ inbox tab -------------------------------- */

// "Seen" state lives client-side, keyed by session id — the backend has no
// read/unread column, and adding one for a single device's convenience isn't
// worth a migration yet. The tradeoff: unread state doesn't follow you to a
// second device. Worth revisiting only if that turns out to matter in
// practice.
const INBOX_SEEN_PREFIX = 'launchpilot:inbox:seen:';

function inboxSeenId(sessionId) {
  try {
    return localStorage.getItem(INBOX_SEEN_PREFIX + sessionId);
  } catch {
    return null;
  }
}

function markInboxSeen(sessionId, messageId) {
  try {
    localStorage.setItem(INBOX_SEEN_PREFIX + sessionId, messageId);
  } catch {
    /* private browsing or a full quota — unread state just won't persist */
  }
}

function relativeTime(iso) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Every conversation the signed-in user is party to, from both sides of the
 * marketplace at once — sessions on listings they own, and sessions where
 * they're the tester. Neither side has its own "all my conversations"
 * endpoint, so this fans out to the per-listing and per-session routes that
 * already exist and flattens the result client-side, rather than adding a
 * new aggregate backend route for what is, in a private beta, a handful of
 * calls.
 */
async function gatherConversations() {
  const [listings, testerSessions] = await Promise.all([client.myListings(), client.mySessions()]);

  const ownerConversations = (
    await Promise.all(
      listings.map((l) =>
        client
          .listingSessions(l.id)
          .then((sessions) =>
            sessions.map((s) => ({
              session: s,
              role: 'owner',
              appName: l.app.name,
              artworkUrl: l.app.artworkUrl,
            })),
          )
          .catch(() => []),
      ),
    )
  ).flat();

  const testerConversations = testerSessions.map((s) => ({
    session: s,
    role: 'tester',
    appName: s.listing.appName,
    artworkUrl: s.listing.artworkUrl,
  }));

  const conversations = [...ownerConversations, ...testerConversations].filter((c) =>
    MESSAGEABLE_STATUSES.has(c.session.status),
  );

  const withMessages = await Promise.all(
    conversations.map(async (c) => ({ ...c, messages: await client.sessionMessages(c.session.id).catch(() => []) })),
  );

  return withMessages
    .map((c) => {
      const last = c.messages.length ? c.messages[c.messages.length - 1] : null;
      const activityAt = last?.createdAt || c.session.respondedAt || c.session.createdAt;
      const unread = Boolean(last) && last.senderUserId !== user?.id && inboxSeenId(c.session.id) !== last.id;
      return { ...c, last, activityAt, unread };
    })
    .sort((a, b) => new Date(b.activityAt) - new Date(a.activityAt));
}

/** Only shown when permission hasn't been asked for yet — once granted or
 * denied, the browser itself is the source of truth and there's nothing
 * left for this banner to offer. */
function notificationsBannerHtml() {
  if (!pushSupported() || pushPermissionState() !== 'default') return '';
  return `
    <div class="callout" style="margin-bottom:1rem;display:flex;justify-content:space-between;align-items:center;gap:.8rem;flex-wrap:wrap">
      <span>Get notified in your browser when a message arrives.</span>
      <button class="primary" id="commEnablePush" type="button">Enable notifications</button>
    </div>`;
}

function wireNotificationsBanner() {
  const btn = el('commEnablePush');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await enablePush(client);
      btn.closest('.callout')?.remove();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = err.message;
    }
  });
}

/** Always visible, unlike the notifications banner — enabling push and
 * actually seeing one arrive are two different things to confirm, and this
 * is useful regardless of which state that permission is in. Opens (or, on
 * a first click, lazily creates) the echo-bot conversation from
 * `push/test-session`; the reply comes back a few seconds later through
 * the exact same send/notify path a real message would. */
function testConversationBannerHtml() {
  return `
    <div class="callout" style="margin-bottom:1rem;display:flex;justify-content:space-between;align-items:center;gap:.8rem;flex-wrap:wrap">
      <span>Want to check notifications actually arrive? The test conversation replies a few
      seconds after you message it — try it with the tab open, then again after switching away
      or closing it.</span>
      <button class="ghost" id="commOpenTestConvo" type="button">Open test conversation</button>
    </div>`;
}

function wireTestConversationBanner() {
  const btn = el('commOpenTestConvo');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const originalText = btn.textContent;
    try {
      const sessionId = await client.testConversation();
      await renderInboxTab();
      const row = document.querySelector(`.inbox-row[data-session="${sessionId}"]`);
      row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row?.click();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = err.message;
      setTimeout(() => {
        btn.textContent = originalText;
      }, 3000);
    }
  });
}

async function renderInboxTab() {
  if (!user) {
    el('commTabPanel').innerHTML = empty(
      '◍',
      'Sign in to see your messages',
      'Conversations open once a testing request is accepted, on either side.',
    );
    return;
  }

  const generation = renderGeneration;
  el('commTabPanel').innerHTML = '<div class="status"><span class="spinner"></span> Loading</div>';
  try {
    const conversations = await gatherConversations();
    if (generation !== renderGeneration) return;

    const banners = notificationsBannerHtml() + testConversationBannerHtml();

    if (!conversations.length) {
      el('commTabPanel').innerHTML =
        banners +
        empty(
          '◍',
          'No conversations yet',
          "They open here once a testing request is accepted — on a listing you own, or one you're testing.",
        );
      wireNotificationsBanner();
      wireTestConversationBanner();
      return;
    }

    el('commTabPanel').innerHTML = `${banners}<div id="commInboxList"></div>`;
    wireNotificationsBanner();
    wireTestConversationBanner();
    const container = el('commInboxList');
    container.innerHTML = conversations.map(inboxRowHtml).join('');
    wireInboxRows(container, conversations);
  } catch (err) {
    el('commTabPanel').innerHTML = `<div class="status error">${escapeHtml(err.message)}</div>`;
  }
}

function inboxRowHtml(c) {
  const { session: s, appName, artworkUrl, role, last, unread } = c;
  const counterparty = role === 'owner' ? s.testerDisplayName || s.testerEmail : 'the app owner';
  const roleLabel = role === 'owner' ? 'Testing your app ·' : "You're testing ·";
  const preview = last ? escapeHtml(last.body).slice(0, 90) : 'No messages yet — say hello.';

  return `
    <button class="inbox-row${unread ? ' unread' : ''}" type="button" data-session="${s.id}">
      ${appIcon(artworkUrl, appName)}
      <div class="inbox-row-body">
        <div class="inbox-row-head">
          <strong>${escapeHtml(appName)}</strong>
          <span class="muted">${roleLabel} ${escapeHtml(counterparty)}</span>
          ${last ? `<span class="inbox-row-time muted">${relativeTime(last.createdAt)}</span>` : ''}
        </div>
        <div class="inbox-row-preview muted">${preview}</div>
      </div>
      ${unread ? '<span class="inbox-dot" aria-label="Unread"></span>' : ''}
    </button>
    <div class="comm-thread" data-session="${s.id}" hidden></div>`;
}

function wireInboxRows(container, conversations) {
  container.querySelectorAll('.inbox-row').forEach((row) => {
    row.addEventListener('click', async () => {
      const id = row.dataset.session;
      const thread = container.querySelector(`.comm-thread[data-session="${id}"]`);
      if (!thread) return;

      const opening = thread.hidden;
      thread.hidden = !opening;
      if (!opening) return;

      if (!thread.dataset.loaded) {
        thread.dataset.loaded = '1';
        await loadThread(id, thread);
      }
      const conv = conversations.find((c) => c.session.id === id);
      if (conv?.last) {
        markInboxSeen(id, conv.last.id);
        row.classList.remove('unread');
        row.querySelector('.inbox-dot')?.remove();
      }
    });
  });
}

async function renderMySessions() {
  const container = el('commMySessions');
  if (!container) return;
  container.innerHTML = '<div class="status"><span class="spinner"></span> Loading</div>';
  try {
    const sessions = await client.mySessions();
    if (!sessions.length) {
      container.innerHTML = empty(
        '◍',
        "You haven't requested to test anything yet",
        'Find something on the Marketplace tab.',
      );
      return;
    }
    container.innerHTML = sessions.map(mySessionCard).join('');
    wireMySessionActions(container);
  } catch (err) {
    container.innerHTML = `<div class="status error">${escapeHtml(err.message)}</div>`;
  }
}

function mySessionCard(s) {
  const tone = STATUS_TONE[s.status] || 'neutral';
  const label = STATUS_LABEL[s.status] || s.status;

  let body = '';
  if (s.status === 'requested') {
    body = `<div class="muted" style="font-size:.82rem;margin-top:.3rem">"${escapeHtml(s.requestMessage)}"</div>`;
  } else if (s.status === 'accepted') {
    body = `
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
          ${s.status === 'completed' ? '<div class="muted" style="font-size:.78rem">+1 token awarded</div>' : ''}
          ${MESSAGEABLE_STATUSES.has(s.status) ? messageThreadHtml(s.id) : ''}
        </div>
      </div>
    </div>`;
}

function wireMySessionActions(container) {
  wireMessageThreads(container);
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
        await renderMySessions();
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
