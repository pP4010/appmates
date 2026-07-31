/**
 * Landing page at `/`. The app itself is `app.html`.
 *
 * Renders sample rows immediately so the page explains the product on a
 * deployment with no community backend — the state every fresh clone starts
 * in — then replaces them wholesale if `COMMUNITY_API_URL` is set. Sample
 * rows keep a visible "sample" tag; real ones drop it, so the page never
 * passes placeholder numbers off as traction.
 *
 * Nothing here can throw into the page. A landing page that renders an
 * error is worse than one that renders the static half and stops.
 */

import { escapeHtml } from './views/shared.js';
import { CommunityClient } from './lib/community.js';
import { DEMO_TESTING, DEMO_LAUNCHED, DEMO_LEADERBOARD } from './landing-demo.js';

const ROW_LIMIT = 6;
/** Rows the board starts at, and how many each "Show more" adds. */
const BOARD_PAGE = 7;
const MEDALS = ['🥇', '🥈', '🥉'];

/* ============================ shared bits ============================ */

/** A stable colour per name, so the same app keeps the same tile across
 * reloads without storing anything. */
function letterTile(name, className = 'tile-icon') {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 360;
  const letter = (name.trim()[0] || '?').toUpperCase();
  return `<span class="${className}" aria-hidden="true"
    style="background:linear-gradient(140deg,hsl(${hash} 62% 52%),hsl(${(hash + 38) % 360} 62% 42%))"
    >${escapeHtml(letter)}</span>`;
}

function healthTone(score) {
  return score >= 80 ? 'ok' : score >= 50 ? 'warn' : 'bad';
}

function metric(label, value, tone = '') {
  return `<div><span class="k">${escapeHtml(label)}</span><span class="v ${tone}">${escapeHtml(String(value))}</span></div>`;
}

/** Alternates the featured tint across a page's featured cards. A counter
 * rather than anything derived from the card itself: the obvious shortcuts
 * (name length, row index) are only *usually* alternating, and the first
 * version of this shipped three warm cards in a row because all three names
 * happened to have odd length. */
let featuredSeen = 0;

function tile({ flag, flagClass, name, genre, note, metrics, featured = false }) {
  const featuredClass = featured ? ` featured${featuredSeen++ % 2 ? ' warm' : ''}` : '';
  return `
    <a class="listing-tile${featuredClass}" href="./app.html#community">
      <span class="tile-flag ${flagClass}">${escapeHtml(flag)}</span>
      <span class="tile-head">
        ${letterTile(name)}
        <span style="min-width:0">
          <span class="tile-name">${escapeHtml(name)}</span>
          <span class="tile-genre">${escapeHtml(genre)}</span>
        </span>
      </span>
      <span class="tile-note">${escapeHtml(note)}</span>
      <span class="tile-metrics">${metrics}</span>
    </a>`;
}

function moreTile(label) {
  return `<a class="row-more" href="./app.html#community">${escapeHtml(label)}</a>`;
}

/* ============================ demo rendering ============================ */

function renderDemo() {
  featuredSeen = 0;
  document.getElementById('rowTesting').innerHTML =
    DEMO_TESTING.map((a) =>
      tile({
        flag: 'NEEDS TESTERS',
        flagClass: 'testing',
        name: a.name,
        genre: a.genre,
        note: a.note,
        featured: a.featured,
        metrics: [
          metric('Testers', a.testers),
          metric('Health', a.health, healthTone(a.health)),
          metric('Days left', a.daysLeft),
        ].join(''),
      }),
    ).join('') + moreTile('Browse every listing looking for testers');

  document.getElementById('rowLaunched').innerHTML =
    DEMO_LAUNCHED.map((a) =>
      tile({
        flag: 'JUST LAUNCHED',
        flagClass: 'launched',
        name: a.name,
        genre: a.genre,
        note: a.note,
        featured: a.featured,
        metrics: [
          metric('Health', a.health, healthTone(a.health)),
          metric('Rating', `${a.rating}★`),
          metric('Ratings', a.ratings),
        ].join(''),
      }),
    ).join('') + moreTile('See every launch and update');

  // Paged and sorted the same way the toggles will render it, so the first
  // paint already matches what a click on "Show more" extends.
  renderBoard(sortedDemo());
}

/* ============================ leaderboard ============================ */

/** One row shape for both the sample board and the live one, so switching
 * between them can't quietly drop a column. */
function demoToRow(e) {
  return {
    rank: e.rank,
    name: e.name,
    sub: `Helped ${e.apps} app${e.apps === 1 ? '' : 's'} ship`,
    lastActive: e.lastActive,
    tests: e.tests,
    tokens: e.tokens,
  };
}

/** SQLite hands back `YYYY-MM-DD HH:MM:SS` in UTC with no zone marker, which
 * `Date` would read as local time — an hours-wide error on a column whose
 * whole job is "how recently". The `T`/`Z` are added back before parsing. */
function relativeTime(timestamp) {
  if (!timestamp) return '—';
  const then = new Date(`${String(timestamp).replace(' ', 'T')}Z`);
  if (Number.isNaN(then.getTime())) return '—';

  const hours = Math.floor((Date.now() - then.getTime()) / 3_600_000);
  if (hours < 1) return 'Just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  return `${days}d ago`;
}

function renderBoard(rows) {
  document.getElementById('lbBody').innerHTML = rows
    .map(
      (r) => `
      <tr>
        <td class="c">${r.rank <= 3 ? `<span class="lb-medal">${MEDALS[r.rank - 1]}</span>` : `<span class="lb-rank">${r.rank}</span>`}</td>
        <td>
          <span class="lb-who">
            ${letterTile(r.name)}
            <span style="min-width:0">
              <span class="lb-name">${escapeHtml(r.name)}</span>
              <span class="lb-sub">${escapeHtml(r.sub)}</span>
            </span>
          </span>
        </td>
        <td class="last-col">${escapeHtml(r.lastActive)}</td>
        <td class="n apps-col">${r.tests}</td>
        <td class="n"><span class="lb-tokens">${r.tokens}</span></td>
      </tr>`,
    )
    .join('');
}

/* ============================ live rendering ============================ */

/** Per section, never wholesale: a live listings row does not make the
 * leaderboard beside it real, and dropping its tag too would relabel sample
 * numbers as traction. */
function clearDemoTag(section) {
  document.querySelector(`[data-demo="${section}"]`)?.remove();
}

/** What the tint and the sweep actually mean on a real listing: its owner
 * spent tokens on the placement — tokens they earned by testing for someone
 * else, since there is no other way to get one. */
function isFeatured(listing) {
  return Boolean(listing.featuredUntil) && new Date(listing.featuredUntil) > new Date();
}

function renderLiveListings(listings) {
  featuredSeen = 0;
  const testing = listings.filter((l) => l.kind === 'testing').slice(0, ROW_LIMIT);
  const launched = listings.filter((l) => l.kind === 'launch').slice(0, ROW_LIMIT);

  if (testing.length) {
    document.getElementById('rowTesting').innerHTML =
      testing
        .map((l) =>
          tile({
            flag: 'NEEDS TESTERS',
            flagClass: 'testing',
            name: l.app.name,
            genre: l.platform === 'android' ? 'Google Play' : l.platform === 'ios' ? 'App Store' : 'iOS + Android',
            note: l.description || 'Open for closed testers.',
            featured: isFeatured(l),
            metrics: [
              metric('Testers', `${l.slotsFilled}/${l.slotsWanted || '∞'}`),
              metric('Given back', l.ownerContribution ?? 0),
              metric('Slots', Math.max(0, (l.slotsWanted || 0) - l.slotsFilled) || '—'),
            ].join(''),
          }),
        )
        .join('') + moreTile('Browse every listing looking for testers');
    clearDemoTag('testing');
  }

  if (launched.length) {
    document.getElementById('rowLaunched').innerHTML =
      launched
        .map((l) =>
          tile({
            flag: 'JUST LAUNCHED',
            flagClass: 'launched',
            name: l.app.name,
            genre: l.platform === 'android' ? 'Google Play' : l.platform === 'ios' ? 'App Store' : 'iOS + Android',
            note: l.description || 'Shipped and open to new users.',
            featured: isFeatured(l),
            metrics: [
              metric('Given back', l.ownerContribution ?? 0),
              metric('Reach', l.slotsFilled || '—'),
              metric('Status', 'Live'),
            ].join(''),
          }),
        )
        .join('') + moreTile('See every launch and update');
    clearDemoTag('launched');
  }
}

function renderLiveLeaderboard(testers) {
  if (!testers.length) return;
  renderBoard(
    testers.map((e) => ({
      rank: e.rank,
      name: e.displayName,
      sub: `Helped ${e.appsHelped ?? 0} app${e.appsHelped === 1 ? '' : 's'} ship`,
      lastActive: relativeTime(e.lastActiveAt),
      tests: e.completedCount,
      tokens: e.tokensEarned,
    })),
  );
  clearDemoTag('leaderboard');
}

/* ============================ boot ============================ */

function wireHeroSearch() {
  const form = document.getElementById('heroSearch');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = document.getElementById('heroInput').value.trim();
    // Handed over as `?app=`, which app.js reads once on boot — the hash is
    // already the router's, so an id cannot ride along in it. An empty box
    // still opens Overview rather than doing nothing.
    location.href = value
      ? `./app.html?app=${encodeURIComponent(value)}#overview`
      : './app.html#overview';
  });
}

/** Board state, and the one place that decides whether a redraw comes from
 * the sample rows or the backend — so the toggles behave the same either
 * way instead of going dead on a deployment with no community backend. */
const board = { sort: 'tokens', windowDays: 30, limit: BOARD_PAGE, client: null };

function sortedDemo() {
  const key = board.sort === 'tests' ? 'tests' : 'tokens';
  return [...DEMO_LEADERBOARD]
    .sort((a, b) => b[key] - a[key] || b.tokens - a.tokens)
    .slice(0, board.limit)
    .map((e, i) => demoToRow({ ...e, rank: i + 1 }));
}

async function refreshBoard() {
  const more = document.getElementById('lbMore');

  if (!board.client?.configured) {
    // The sample board has a fixed number of rows; once they are all shown
    // there is nothing further to reveal.
    renderBoard(sortedDemo());
    more.disabled = board.limit >= DEMO_LEADERBOARD.length;
    more.textContent = more.disabled ? 'That’s everyone' : 'Show more';
    return;
  }

  try {
    const data = await board.client.leaderboard({
      windowDays: board.windowDays,
      sort: board.sort,
      limit: board.limit,
    });
    if (!data.testers.length) return;
    renderLiveLeaderboard(data.testers);
    // A short page back means the server had nothing more to give.
    more.disabled = data.testers.length < board.limit;
    more.textContent = more.disabled ? 'That’s everyone' : 'Show more';
  } catch {
    /* Leave whatever the board already shows rather than blanking it. */
  }
}

function wireBoardControls() {
  document.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const group = btn.closest('.seg');
      group.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      if (btn.dataset.sort) board.sort = btn.dataset.sort;
      if (btn.dataset.window) board.windowDays = Number(btn.dataset.window);
      board.limit = BOARD_PAGE;
      refreshBoard();
    });
  });

  document.getElementById('lbMore').addEventListener('click', () => {
    board.limit += BOARD_PAGE;
    refreshBoard();
  });
}

async function boot() {
  renderDemo();
  wireHeroSearch();
  wireBoardControls();

  const client = new CommunityClient();
  if (!client.configured) {
    refreshBoard();
    return;
  }

  // Independent on purpose: a leaderboard outage should not also cost the
  // page its listings, so each half settles on its own.
  const [listings, boardResult] = await Promise.allSettled([
    client.browseListings(undefined, 'newest'),
    client.leaderboard({ windowDays: board.windowDays, sort: board.sort, limit: board.limit }),
  ]);

  if (listings.status === 'fulfilled') renderLiveListings(listings.value);

  if (boardResult.status === 'fulfilled' && boardResult.value.testers.length) {
    // Adopted only once it has actually answered with rows, so the toggles
    // never start querying a backend that just proved it has nothing —
    // they keep driving the sample board instead, tag and all.
    board.client = client;
    renderLiveLeaderboard(boardResult.value.testers);
    const more = document.getElementById('lbMore');
    more.disabled = boardResult.value.testers.length < board.limit;
    more.textContent = more.disabled ? 'That’s everyone' : 'Show more';
  } else {
    refreshBoard();
  }
}

boot().catch(() => {
  /* The static half of the page still stands. */
});
