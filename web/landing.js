/**
 * Landing page: the public front door, at `/`. The app itself is `app.html`.
 *
 * Everything here degrades to nothing. The two community sections start
 * hidden in the markup and are only revealed once real data arrives, so a
 * deployment with no community backend configured — or one whose backend is
 * down — shows a landing page about the tools rather than a row of empty
 * shelves. That is also why this module never throws into the page: a
 * marketing page that renders an error is worse than one that renders less.
 *
 * The listing cards recompute their headline numbers from the public store
 * catalogue as they render, exactly as they do inside the app. That is the
 * product's actual claim, so the landing page should not be the one place it
 * is faked with a hardcoded figure.
 */

import { escapeHtml } from './views/shared.js';
import { CommunityClient } from './lib/community.js';
import { ITunesClient } from './lib/itunes.js';
import { loadAppHealthSpec, checkAppHealth, profileFromEntry } from './lib/app-profile.js';

/** A landing page shows a taste, not a directory — and each card costs one
 * throttled catalogue lookup, so this is also what keeps the page from
 * spending twenty seconds filling in numbers nobody scrolled to. */
const SHOWCASE_LIMIT = 3;
const LEADERBOARD_LIMIT = 5;

const MEDALS = ['🥇', '🥈', '🥉'];

function reveal(id) {
  document.getElementById(id)?.classList.remove('hidden');
}

/* ============================ listings ============================ */

function card(listing) {
  const kindLabel = listing.kind === 'testing' ? 'Looking for testers' : 'Launch / update';
  const slots = `${listing.slotsFilled}/${listing.slotsWanted || '∞'}`;

  return `
    <div class="panel marketplace-card">
      <div class="marketplace-card-head">
        ${
          listing.app.artworkUrl
            ? `<img class="app-icon" src="${escapeHtml(listing.app.artworkUrl)}" alt="" loading="lazy">`
            : '<span class="app-icon"></span>'
        }
        <div style="min-width:0;flex:1">
          <strong class="marketplace-card-name">${escapeHtml(listing.app.name)}</strong>
          <div class="marketplace-card-badges">
            <span class="pill ${listing.kind === 'testing' ? 'info' : 'ok'}">${kindLabel}</span>
          </div>
        </div>
      </div>
      <div class="marketplace-card-metrics">
        <div class="mini-metric">
          <span class="metric-label">Health</span>
          <span class="metric-value pending" data-health="${listing.id}">…</span>
        </div>
        <div class="mini-metric">
          <span class="metric-label">Rating</span>
          <span class="metric-value pending" data-rating="${listing.id}">…</span>
        </div>
        <div class="mini-metric">
          <span class="metric-label">Testers</span>
          <span class="metric-value">${slots}</span>
        </div>
      </div>
      <a class="landing-cta ghost" href="./app.html#community">Request to test</a>
    </div>`;
}

function setCell(attr, id, text, tone = '') {
  const node = document.querySelector(`[data-${attr}="${id}"]`);
  if (node) {
    node.className = `metric-value ${tone}`;
    node.textContent = text;
  }
}

/** Sequential on purpose: `ITunesClient` throttles anyway, so firing these in
 * parallel would only queue them behind each other. Each card fails on its
 * own — one app the catalogue won't answer for shows a dash, not a broken
 * row of cards. */
async function enrich(listings, itunes) {
  for (const listing of listings) {
    if (!listing.app?.trackId) continue;
    try {
      const entry = await itunes.lookup(String(listing.app.trackId), {
        country: listing.app.country || 'us',
      });
      if (!entry) throw new Error('not in catalogue');

      const report = checkAppHealth(profileFromEntry(entry));
      const score = Math.round(report.score);
      setCell('health', listing.id, `${score}/100`, score >= 80 ? 'ok' : score >= 50 ? 'warn' : 'bad');
      setCell(
        'rating',
        listing.id,
        report.profile.rating ? `${report.profile.rating.toFixed(1)}★` : 'No ratings',
      );
    } catch {
      setCell('health', listing.id, '—');
      setCell('rating', listing.id, '—');
    }
  }
}

/* ============================ leaderboard ============================ */

function leaderboardRows(entries) {
  return entries
    .map(
      (e) => `
      <div class="lb-row ${e.rank <= 3 ? 'top' : ''}">
        <span class="lb-rank">${e.rank <= 3 ? MEDALS[e.rank - 1] : e.rank}</span>
        <span class="lb-name">${escapeHtml(e.displayName)}</span>
        <span class="lb-tests">${e.completedCount} test${e.completedCount === 1 ? '' : 's'}</span>
        <span class="lb-tokens">${e.tokensEarned} <span class="unit">tokens</span></span>
      </div>`,
    )
    .join('');
}

/* ============================ boot ============================ */

async function boot() {
  const client = new CommunityClient();
  if (!client.configured) return;

  // Listings and the board are independent: one failing should not cost the
  // page the other, so they settle separately rather than through a single
  // Promise.all that any one rejection would take down.
  const [listingsResult, boardResult] = await Promise.allSettled([
    client.browseListings('testing', 'newest'),
    client.leaderboard(),
  ]);

  if (boardResult.status === 'fulfilled' && boardResult.value.testers.length) {
    document.getElementById('landingLeaderboard').innerHTML = leaderboardRows(
      boardResult.value.testers.slice(0, LEADERBOARD_LIMIT),
    );
    reveal('leaderboard');
  }

  if (listingsResult.status === 'fulfilled' && listingsResult.value.length) {
    const listings = listingsResult.value.slice(0, SHOWCASE_LIMIT);
    document.getElementById('landingListings').innerHTML = listings.map(card).join('');
    reveal('testers');

    // Only needed for the health score, and only once there is a card to put
    // it on — a visitor who never sees a listing never pays for this fetch.
    try {
      const specs = await (await fetch('./lib/specs.json')).json();
      loadAppHealthSpec(specs);
      await enrich(listings, new ITunesClient());
    } catch {
      for (const listing of listings) {
        setCell('health', listing.id, '—');
        setCell('rating', listing.id, '—');
      }
    }
  }
}

boot().catch(() => {
  /* The tools half of this page is static markup and still stands. */
});
