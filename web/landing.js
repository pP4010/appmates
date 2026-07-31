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
import { ITunesClient } from './lib/itunes.js';
import {
  DEMO_TESTING,
  DEMO_LAUNCHED,
  DEMO_LEADERBOARD,
  RAIL_LEFT,
  RAIL_RIGHT,
} from './landing-demo.js';

const ROW_LIMIT = 6;
/** Rows the board starts at, and how many each "Show more" adds. */
const BOARD_PAGE = 7;
/** Catalogue lookups are throttled, so a fully expanded board would spend a
 * long time filling in rows nobody scrolled to. */
const RATINGS_LOOKUP_LIMIT = 10;
const CONTACT_EMAIL = 'kaizenapp.contact@gmail.com';
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
    appName: e.ownApp,
    appDesc: e.ownAppDesc,
    tests: e.tests,
    ratings: e.ratings,
  };
}

/** An em dash, not a blank or a zero: plenty of the best testers here have
 * not shipped anything yet, and an empty cell would read as missing data
 * rather than as a real answer. */
const NONE = '—';

/**
 * Icon, name, one line of context — the same shape a marketplace board uses
 * for the entity each row is about.
 *
 * The icon starts as a generated letter tile even for live rows: the real
 * artwork arrives a throttled lookup later, and swapping a placeholder for
 * it is far less jarring than a row that reflows when an image pops in.
 */
function appCell(r) {
  const key = r.ratingsKey ? ` data-app="${escapeHtml(r.ratingsKey)}"` : '';
  return `
    <span class="lb-app-cell"${key}>
      ${letterTile(r.appName, 'lb-app-icon')}
      <span style="min-width:0">
        <span class="lb-app">${escapeHtml(r.appName)}</span>
        <span class="lb-app-desc">${escapeHtml(r.appDesc ?? '')}</span>
      </span>
    </span>`;
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
        <td class="app-col">${r.appName ? appCell(r) : `<span class="lb-none">${NONE}</span>`}</td>
        <td class="n apps-col">${r.tests}</td>
        <td class="n">${
          r.appName
            ? `<span class="lb-ratings"${r.ratingsKey ? ` data-ratings="${escapeHtml(r.ratingsKey)}"` : ''}>${
                r.ratings ?? '…'
              }</span>`
            : `<span class="lb-none">${NONE}</span>`
        }</td>
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
      appName: e.ownApp?.name ?? null,
      // Both left blank for `fillAppFacts`: the rating count and the
      // category are live properties of the listing, so storing either
      // would only mean showing a stale number with a straight face.
      appDesc: null,
      ratings: null,
      ratingsKey: e.ownApp?.trackId ?? null,
      tests: e.completedCount,
    })),
  );
  clearDemoTag('leaderboard');
  fillAppFacts(testers);
}

/** Reads each listed app's icon, category and rating count straight from
 * the public catalogue, one throttled lookup at a time. Per-row failures
 * leave the letter tile and a dash rather than a spinner that never
 * resolves. */
async function fillAppFacts(testers) {
  const withApps = testers.filter((e) => e.ownApp?.trackId).slice(0, RATINGS_LOOKUP_LIMIT);
  if (!withApps.length) return;

  const itunes = new ITunesClient();
  for (const tester of withApps) {
    const key = CSS.escape(String(tester.ownApp.trackId));
    let ratings = NONE;
    let entry = null;
    try {
      entry = await itunes.lookup(String(tester.ownApp.trackId), {
        country: tester.ownApp.country || 'us',
      });
      const count = Number(entry?.userRatingCount ?? 0);
      ratings = count > 0 ? count.toLocaleString('en-US') : 'No ratings';
    } catch {
      /* leaves the letter tile and the dash */
    }

    document.querySelectorAll(`[data-ratings="${key}"]`).forEach((node) => {
      node.textContent = ratings;
    });

    if (!entry) continue;
    document.querySelectorAll(`[data-app="${key}"]`).forEach((cell) => {
      const artwork = entry.artworkUrl100 ?? entry.artworkUrl512;
      const tile = cell.querySelector('.lb-app-icon');
      if (artwork && tile) {
        const img = document.createElement('img');
        img.className = 'lb-app-icon';
        img.src = artwork;
        img.alt = '';
        img.loading = 'lazy';
        tile.replaceWith(img);
      }
      const desc = cell.querySelector('.lb-app-desc');
      if (desc) desc.textContent = entry.primaryGenreName ?? '';
    });
  }
}

/* ============================ promoted rails ============================ */

function railCard(app) {
  return `
    <a class="rail-card" href="${escapeHtml(app.storeUrl)}" target="_blank" rel="noopener">
      <span class="rail-tag">Promoted</span>
      ${app.artwork ? `<img class="rail-icon" src="${escapeHtml(app.artwork)}" alt="" loading="lazy">` : ''}
      <span class="rail-name">${escapeHtml(app.name)}</span>
      ${app.genre ? `<span class="rail-genre">${escapeHtml(app.genre)}</span>` : ''}
    </a>`;
}

/**
 * A taken slot whose catalogue lookup failed.
 *
 * The tempting fallback — render the empty "available" card — would invite
 * someone to ask for a slot that is already sold, so a slot that is taken
 * stays visibly taken. `slot.name`, when the config supplied one, beats the
 * generic label for exactly this case — a lookup can fail for reasons that
 * have nothing to do with the app (the catalogue rate-limits, a network
 * hiccup), and there's no reason to show "Promoted app" when the real name
 * was sitting right there in `landing-demo.js`. The store link is built
 * from the id alone, so the card stays useful without any lookup at all.
 */
function unresolvedSlot(slot) {
  return railCard({
    name: slot.name || 'Promoted app',
    genre: '',
    artwork: '',
    storeUrl: `https://apps.apple.com/app/id${encodeURIComponent(slot.trackId)}`,
  });
}

function emptySlot() {
  return `
    <a class="rail-card empty" data-filler href="mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('Featuring my app on AppMates')}">
      <span class="rail-tag">Available</span>
      <span class="rail-name">Your app here</span>
      <span class="rail-desc">Get in touch to take this slot.</span>
    </a>`;
}

/**
 * Fills both rails. The promoted entries are resolved from the catalogue so
 * the name, icon and category track whatever is actually on the store — a
 * slot advertising a stale version of an app is worse than an empty one, so
 * a lookup that fails falls back to an available slot rather than to a
 * half-rendered card.
 */
async function renderRails() {
  const left = document.getElementById('railLeft');
  const right = document.getElementById('railRight');
  // Empty slots need no network, so they paint immediately.
  left.innerHTML = RAIL_LEFT.map(() => emptySlot()).join('');
  right.innerHTML =
    RAIL_RIGHT.map(() => emptySlot()).join('') +
    `<span class="rail-foot">Want a slot? <a href="mailto:${CONTACT_EMAIL}">Ask here</a></span>`;
  fillRailHeight(left);
  fillRailHeight(right);

  const itunes = new ITunesClient();
  const resolve = async (slots) => {
    const out = [];
    for (const slot of slots) {
      if (slot.empty || !slot.trackId) {
        out.push(emptySlot());
        continue;
      }
      try {
        const entry = await itunes.lookup(slot.trackId, { country: slot.country || 'us' });
        out.push(
          entry
            ? railCard({
                name: entry.trackName,
                genre: entry.primaryGenreName ?? '',
                artwork: entry.artworkUrl100 ?? entry.artworkUrl512 ?? '',
                storeUrl: entry.trackViewUrl ?? '',
              })
            : unresolvedSlot(slot),
        );
      } catch {
        out.push(unresolvedSlot(slot));
      }
    }
    return out;
  };

  const [leftCards, rightCards] = [await resolve(RAIL_LEFT), await resolve(RAIL_RIGHT)];
  left.innerHTML = leftCards.join('');
  right.innerHTML =
    rightCards.join('') +
    `<span class="rail-foot">Want a slot? <a href="mailto:${CONTACT_EMAIL}">Ask here</a></span>`;
  fillRailHeight(left);
  fillRailHeight(right);
}

/** A card at roughly this height reads as a real promoted slot rather than
 * a sliver or a poster — the target `fillRailHeight` sizes the column
 * toward, not a hard minimum (that lives in the `.rail-card` CSS). */
const IDEAL_RAIL_CARD_HEIGHT = 148;

/**
 * Tops up a rail with "Available" cards so the column always divides evenly
 * across its full height, with every card — the real one included —
 * stretching to fill its share (`.rail-card` is `flex: 1 1 0`). That mirrors
 * how a marketplace like trustmrr.com fills its promoted rails: a handful of
 * evenly sized tiles reaching edge to edge, not one small card sitting above
 * a column of leftover space.
 *
 * The target count comes from how many `IDEAL_RAIL_CARD_HEIGHT` cards would
 * fit, not from measuring rendered heights — with `flex: 1 1 0` a card's
 * rendered height depends on how many siblings it has, so probing one in
 * isolation can't tell you how many belong in the column.
 *
 * Idempotent: existing `[data-filler]` cards are cleared first, so calling
 * this again after a resize (or after the real promoted card replaces the
 * placeholder it started as) recomputes cleanly instead of accumulating.
 */
function fillRailHeight(rail) {
  rail.querySelectorAll('[data-filler]').forEach((node) => node.remove());
  if (getComputedStyle(rail).display === 'none') return;

  const available = rail.getBoundingClientRect().height;
  const gap = parseFloat(getComputedStyle(rail).rowGap) || 0;
  const foot = rail.querySelector('.rail-foot');
  const footSpace = foot ? foot.getBoundingClientRect().height + gap : 0;

  const realCount = rail.children.length - (foot ? 1 : 0);
  const usable = available - footSpace;
  const targetCount = Math.max(realCount, Math.round((usable + gap) / (IDEAL_RAIL_CARD_HEIGHT + gap)));

  for (let i = realCount; i < targetCount; i++) {
    const filler = document.createElement('a');
    filler.className = 'rail-card empty';
    filler.dataset.filler = '';
    filler.href = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('Featuring my app on AppMates')}`;
    filler.innerHTML = `
      <span class="rail-tag">Available</span>
      <span class="rail-name">Your app here</span>
      <span class="rail-desc">Get in touch to take this slot.</span>`;
    rail.insertBefore(filler, foot);
  }
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
const board = { sort: 'tests', windowDays: 30, limit: BOARD_PAGE, client: null };

function sortedDemo() {
  const key = board.sort === 'apps' ? 'apps' : 'tests';
  const tieBreak = key === 'apps' ? 'tests' : 'apps';
  return [...DEMO_LEADERBOARD]
    .sort((a, b) => b[key] - a[key] || b[tieBreak] - a[tieBreak])
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

/** Re-measures both rails after the viewport settles, so height added by a
 * window resize (or the sidebar crossing the 1180px breakpoint) is filled
 * — and height removed doesn't leave the last few filler cards clipped by
 * `overflow: hidden`. Debounced: a drag-resize fires this dozens of times a
 * second, and only the last one, after the user stops, needs to run. */
function wireRailResize() {
  let timer;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      fillRailHeight(document.getElementById('railLeft'));
      fillRailHeight(document.getElementById('railRight'));
    }, 150);
  });
}

async function boot() {
  renderDemo();
  wireHeroSearch();
  wireBoardControls();
  wireRailResize();
  // Not awaited: the rails are decoration, and a slow catalogue lookup for
  // them must not hold up the live community data below.
  renderRails();

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
