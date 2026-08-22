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
import { CommunityClient, itunesRelayOptions } from './lib/community.js';
import { ITunesClient } from './lib/itunes.js';
import { fetchSponsorSlots, mountTape } from './lib/sponsor-tape.js';
import { checkAppHealth, loadAppHealthSpec, profileFromEntry } from './lib/app-profile.js';
import { startPresencePing } from './lib/presence.js';
import { initSponsorView, showSponsorView, hideSponsorView } from './sponsor-view.js';
import { initBrowseView, showBrowseView, hideBrowseView } from './browse-view.js';
import {
  DEMO_TESTING,
  DEMO_LAUNCHED,
  DEMO_LEADERBOARD,
  RAIL_LEFT,
  RAIL_RIGHT,
} from './landing-demo.js';

const ROW_LIMIT = 6;
/** Rows the board starts at, and how many each "Show more" adds. */
const BOARD_PAGE = 15;
/** Catalogue lookups are throttled, so a fully expanded board would spend a
 * long time filling in rows nobody scrolled to. */
const RATINGS_LOOKUP_LIMIT = 10;
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

function metric(label, value, tone = '', icon = '', hook = '') {
  const iconHtml = icon ? `<img class="metric-icon" src="${icon}" alt="" width="17" height="17">` : '';
  const hookAttr = hook ? ` data-metric="${hook}"` : '';
  return `<div><span class="k">${escapeHtml(label)}</span><span class="v ${tone}"${hookAttr}>${escapeHtml(String(value))}${iconHtml}</span></div>`;
}

/** Alternates the featured tint across a page's featured cards. A counter
 * rather than anything derived from the card itself: the obvious shortcuts
 * (name length, row index) are only *usually* alternating, and the first
 * version of this shipped three warm cards in a row because all three names
 * happened to have odd length. */
let featuredSeen = 0;

function tile({ flag, flagClass, name, genre, note, metrics, featured = false, boostTier = 0, icon = '', trackId = '' }) {
  const featuredClass = featured ? ` featured${featuredSeen++ % 2 ? ' warm' : ''}` : '';
  const boostClass = boostTier ? ` boost-${boostTier}` : '';
  const trackAttr = trackId ? ` data-track="${escapeHtml(String(trackId))}"` : '';
  return `
    <a class="listing-tile${featuredClass}${boostClass}" href="./app.html#community"${trackAttr}>
      <span class="tile-flag ${flagClass}">${escapeHtml(flag)}</span>
      <span class="tile-head">
        ${icon ? `<img class="tile-icon" src="${icon}" alt="">` : letterTile(name)}
        <span style="min-width:0">
          <span class="tile-name">${escapeHtml(name)}</span>
          <span class="tile-genre">${escapeHtml(genre)}</span>
        </span>
      </span>
      <span class="tile-note">${escapeHtml(note)}</span>
      <span class="tile-metrics">${metrics}</span>
    </a>`;
}

function moreTile(label, href) {
  return `<a class="row-more" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
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
        trackId: a.trackId,
        metrics: [
          metric('Testers', a.testers),
          metric('High 5s', a.helped, '', './assets/darkHighFive.png'),
          metric('Days left', a.daysLeft),
        ].join(''),
      }),
    ).join('') + moreTile('Browse every listing looking for testers', '#browse-testing');

  document.getElementById('rowLaunched').innerHTML =
    DEMO_LAUNCHED.map((a) =>
      tile({
        flag: 'JUST LAUNCHED',
        flagClass: 'launched',
        name: a.name,
        genre: a.genre,
        note: a.note,
        trackId: a.trackId,
        metrics: [
          metric('Health', '—', '', '', 'health'),
          metric('Rating', '—', '', '', 'rating'),
          metric('Ratings', '—', '', '', 'ratings'),
        ].join(''),
      }),
    ).join('') + moreTile('See every launch and update', '#browse-launched');

  // Paged and sorted the same way the toggles will render it, so the first
  // paint already matches what a click on "Show more" extends.
  renderBoard(sortedDemo());

  // Not awaited: real icon/genre/health are a nice-to-have patched in once
  // available, not something the rest of boot() should wait on.
  hydrateDemoApps();
}

/** `DEMO_TESTING`/`DEMO_LAUNCHED` name real apps (the site's own, before
 * any third-party listing exists) via `trackId`, so their icon, genre and
 * (for the launched row) health/rating/ratings come from the public
 * catalogue instead of being invented — everything else about the row
 * (testers signed up, High Fives, days left) still is, same as the
 * "sample" tag on the page already discloses. Each distinct app is looked
 * up once and patched into every card that names it via `[data-track]`,
 * the same multi-target approach `fillAppFacts` uses for the board. */
async function hydrateDemoApps() {
  const trackIds = [...new Set(
    [...DEMO_TESTING, ...DEMO_LAUNCHED].map((a) => a.trackId).filter(Boolean),
  )];
  if (!trackIds.length) return;

  let specsLoaded = false;
  try {
    loadAppHealthSpec(await (await fetch('./lib/specs.json')).json());
    specsLoaded = true;
  } catch {
    /* health metric stays '—' below if this fails */
  }

  const itunes = new ITunesClient(itunesRelayOptions());
  for (const trackId of trackIds) {
    let entry;
    try {
      entry = await itunes.lookup(trackId, { country: 'us' });
    } catch {
      continue; // leaves the letter tile and '—' placeholders for this app
    }
    if (!entry) continue;

    const cells = document.querySelectorAll(`[data-track="${CSS.escape(trackId)}"]`);
    cells.forEach((cell) => {
      const artwork = entry.artworkUrl100 ?? entry.artworkUrl512;
      const iconEl = cell.querySelector('.tile-icon');
      if (artwork && iconEl && iconEl.tagName !== 'IMG') {
        const img = document.createElement('img');
        img.className = 'tile-icon';
        img.src = artwork;
        img.alt = '';
        iconEl.replaceWith(img);
      }
      const nameEl = cell.querySelector('.tile-name');
      if (nameEl && entry.trackName) nameEl.textContent = entry.trackName;
      const genreEl = cell.querySelector('.tile-genre');
      if (genreEl && entry.primaryGenreName) genreEl.textContent = entry.primaryGenreName;

      const ratingEl = cell.querySelector('[data-metric="rating"]');
      if (ratingEl) {
        const rating = Number(entry.averageUserRating);
        ratingEl.textContent = rating ? `${rating.toFixed(1)}★` : '-.-★';
      }
      const ratingsEl = cell.querySelector('[data-metric="ratings"]');
      if (ratingsEl) {
        const count = Number(entry.userRatingCount ?? 0);
        ratingsEl.textContent = count > 0 ? count.toLocaleString('en-US') : '-';
      }
      const healthEl = cell.querySelector('[data-metric="health"]');
      if (healthEl && specsLoaded) {
        try {
          const { score } = checkAppHealth(profileFromEntry(entry));
          healthEl.textContent = String(Math.round(score));
          healthEl.className = `v ${healthTone(score)}`;
        } catch {
          /* leaves '—' */
        }
      }
    });
  }
}

/* ============================ leaderboard ============================ */

/** `trackId` (as a string) -> `'ios'|'android'|'both'`, for the board's
 * "their app" cell. The leaderboard's own data (a tester's connected app)
 * carries no platform of its own — only a *listing* does, chosen by hand
 * in the "Post a listing" form (`web/views/community.js`'s `#commPlatform`
 * select). This index is built from whatever listings are already in
 * memory (the same fetch `boot()` makes for the rows above) and matched
 * back onto board rows by `trackId`, so a real answer shows up without
 * asking the board for a second network round trip — but it only covers
 * apps with a currently-open listing, never a guess for the rest. Seeded
 * with the two demo apps' real (App-Store-only, today) platform so local
 * dev and a backend-less deployment still show a badge on them. */
const platformByTrack = new Map(
  [...DEMO_TESTING, ...DEMO_LAUNCHED].filter((a) => a.trackId).map((a) => [String(a.trackId), 'ios']),
);

function mergeListingPlatforms(listings) {
  for (const l of listings) {
    if (l.app?.trackId) platformByTrack.set(String(l.app.trackId), l.platform);
  }
}

/** One row shape for both the sample board and the live one, so switching
 * between them can't quietly drop a column.
 *
 * `ownApp` is a plain string for the fictional sample rows, but a `{ name,
 * trackId, country }` object for the two real ones — see `DEMO_LEADERBOARD`.
 * Only the latter gets a `ratingsKey`, which is what tells `renderBoard`
 * to render the `data-app`/`data-ratings` hooks `fillAppFacts` patches once
 * the catalogue lookup for that row resolves. */
function demoToRow(e) {
  const linked = e.ownApp && typeof e.ownApp === 'object';
  const trackId = linked ? e.ownApp.trackId : null;
  return {
    rank: e.rank,
    name: e.name,
    sub: `Helped ${e.apps} app${e.apps === 1 ? '' : 's'} ship`,
    appName: linked ? e.ownApp.name : e.ownApp,
    appDesc: e.ownAppDesc,
    tests: e.tests,
    ratings: e.ratings,
    ratingsKey: trackId,
    platform: trackId ? platformByTrack.get(String(trackId)) : null,
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
  const platformAttr = r.platform ? ` data-platform="${escapeHtml(r.platform)}"` : '';
  return `
    <span class="lb-app-cell"${key}${platformAttr}>
      <span class="lb-app-icon-wrap">${letterTile(r.appName, 'lb-app-icon')}</span>
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
            note: l.tagline || 'Open for closed testers.',
            icon: l.app.artworkUrl,
            trackId: l.app.trackId,
            featured: isFeatured(l),
            boostTier: l.ownerBoostTier ?? 0,
            metrics: [
              metric('Testers', `${l.slotsFilled}/${l.slotsWanted || '∞'}`),
              metric('High 5s', l.ownerContribution ?? 0, '', './assets/darkHighFive.png'),
              metric('Slots', Math.max(0, (l.slotsWanted || 0) - l.slotsFilled) || '—'),
            ].join(''),
          }),
        )
        .join('') + moreTile('Browse every listing looking for testers', '#browse-testing');
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
            note: l.tagline || 'Shipped and open to new users.',
            icon: l.app.artworkUrl,
            trackId: l.app.trackId,
            featured: isFeatured(l),
            boostTier: l.ownerBoostTier ?? 0,
            metrics: [
              metric('High 5s', l.ownerContribution ?? 0, '', './assets/darkHighFive.png'),
              metric('Reach', l.slotsFilled || '—'),
              metric('Status', 'Live'),
            ].join(''),
          }),
        )
        .join('') + moreTile('See every launch and update', '#browse-launched');
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
      // `ownApp.platform` is the real, backend-known fact once the API
      // sends it (see `platformByTrack`'s own comment) — the listings-based
      // guess only ever fills in for a deployment still on the older API.
      platform: e.ownApp?.platform ?? (e.ownApp?.trackId ? platformByTrack.get(String(e.ownApp.trackId)) : null),
    })),
  );
  clearDemoTag('leaderboard');
  fillAppFacts(testers.map((e) => e.ownApp).filter(Boolean));
}

/** The corner badge's icon(s): Apple/Google/both, from the row's known
 * `platform` (via `data-platform`, set in `appCell()` from `platformByTrack`
 * — see its own comment for where that fact actually comes from). Falls
 * back to the Apple mark alone when platform isn't known but the row still
 * resolved through `itunes.lookup` — a hit there is at minimum a fact about
 * the App Store, never a guess. `both` stacks the two marks in a small
 * diagonal fan rather than trying to cram both logos into one 16px badge. */
function storeBadgeHtml(platform) {
  if (platform === 'android') {
    return '<span class="store-badge google"><img src="./assets/google-play.png" alt="Google Play" width="14" height="14"></span>';
  }
  if (platform === 'both') {
    // Each mark gets its own little tile — same flex-centered, `overflow:
    // hidden` shape `.store-badge` itself uses (styles.css), not the mark
    // styled directly — an `<img>` sized/cropped on its own is how the
    // Apple mark previously ended up floating in whitespace instead of
    // filling its tile the way the single-store badge does.
    return (
      '<span class="store-badge both" role="img" aria-label="App Store and Google Play">' +
      '<span class="store-badge-a"><img src="./assets/app-store.png" alt=""></span>' +
      '<span class="store-badge-b google"><img src="./assets/google-play.png" alt=""></span>' +
      '</span>'
    );
  }
  return '<span class="store-badge apple"><img src="./assets/app-store.png" alt="App Store" width="14" height="14"></span>';
}

/**
 * Reads each listed app's icon, real title, category and rating count
 * straight from the public catalogue, one throttled lookup at a time, and
 * patches the row(s) already on the board for that `trackId` — live testers
 * and the two self-promoted `DEMO_LEADERBOARD` rows alike, since both went
 * through `demoToRow`/`renderBoard` and carry the same `data-app`/
 * `data-ratings` hooks. Per-row failures leave the letter tile, the label
 * this file was given, and a dash — never a spinner that never resolves.
 *
 * Apple's catalogue is the only live lookup this runs — an Android-only
 * app's `trackId` is a Play package id, so `itunes.lookup` simply never
 * matches it and `entry` stays null. That still leaves the *platform* badge
 * (known independently, from `platformByTrack`) and, when the app object
 * already carries one (`app.artworkUrl`, forward-compatible with a backend
 * that starts sending it), a real icon instead of the letter tile forever.
 */
async function fillAppFacts(apps) {
  const withApps = apps.filter((a) => a.trackId).slice(0, RATINGS_LOOKUP_LIMIT);
  if (!withApps.length) return;

  const itunes = new ITunesClient(itunesRelayOptions());
  for (const app of withApps) {
    const key = CSS.escape(String(app.trackId));
    let ratings = NONE;
    let entry = null;
    try {
      entry = await itunes.lookup(String(app.trackId), { country: app.country || 'us' });
      const count = Number(entry?.userRatingCount ?? 0);
      ratings = count > 0 ? count.toLocaleString('en-US') : 'No ratings';
    } catch {
      /* leaves the letter tile and the dash */
    }

    document.querySelectorAll(`[data-ratings="${key}"]`).forEach((node) => {
      node.textContent = ratings;
    });

    document.querySelectorAll(`[data-app="${key}"]`).forEach((cell) => {
      const artwork = entry?.artworkUrl100 ?? entry?.artworkUrl512 ?? app.artworkUrl;
      const tile = cell.querySelector('.lb-app-icon');
      if (artwork && tile) {
        const img = document.createElement('img');
        img.className = 'lb-app-icon';
        img.src = artwork;
        img.alt = '';
        img.loading = 'lazy';
        tile.replaceWith(img);
      }
      // Revealed on row hover by CSS, same corner-badge markup the
      // dashboard's own test cards use (`.store-badge` in styles.css).
      const platform = cell.dataset.platform;
      const wrap = cell.querySelector('.lb-app-icon-wrap');
      if (wrap && !wrap.querySelector('.store-badge') && (entry || platform)) {
        wrap.insertAdjacentHTML('beforeend', storeBadgeHtml(platform));
      }
      if (entry) {
        const name = cell.querySelector('.lb-app');
        if (name && entry.trackName) name.textContent = entry.trackName;
        const desc = cell.querySelector('.lb-app-desc');
        if (desc) desc.textContent = entry.primaryGenreName ?? '';
      }
    });
  }
}

/* ============================ promoted rails ============================ */

/** Which side of the page a rail belongs to, from its element id — used to
 * point that side's "Available" cards at the matching column on the
 * sponsor page instead of a side-agnostic link. */
function railSide(rail) {
  return rail.id === 'railLeft' ? 'left' : 'right';
}

function railCard(app) {
  const colorClass = app.color ? ` rail-card--${escapeHtml(app.color)}` : '';
  return `
    <a class="rail-card${colorClass}" href="${escapeHtml(app.storeUrl)}" target="_blank" rel="noopener">
      ${app.artwork ? `<img class="rail-icon" src="${escapeHtml(app.artwork)}" alt="" loading="lazy">` : ''}
      <span class="rail-name">${escapeHtml(app.name)}</span>
      ${app.genre ? `<span class="rail-genre">${escapeHtml(app.genre)}</span>` : ''}
    </a>`;
}

function emptySlot(side) {
  return `
    <a class="rail-card empty" data-filler href="#sponsor-${side}">
      <span class="rail-tag">Available</span>
      <span class="rail-name">Your app here</span>
      <span class="rail-desc">Claim this slot.</span>
    </a>`;
}

/**
 * Tags every `.rail-card` whose `.rail-name` actually wrapped to a second
 * line with `name-wrap`, so the CSS above can pull the icon and genre in
 * around it. Measured rather than guessed from string length: a name's
 * wrap point depends on which characters it's made of and which font
 * loaded, not on a character count this function would otherwise have to
 * approximate.
 */
function markWrappedNames(rail) {
  for (const name of rail.querySelectorAll('.rail-name')) {
    const lineHeight = parseFloat(getComputedStyle(name).lineHeight);
    const wrapped = name.scrollHeight > lineHeight * 1.5;
    name.closest('.rail-card')?.classList.toggle('name-wrap', wrapped);
  }
}

/**
 * Fills both rails, and the two compact tapes that stand in for them below
 * the rails' own width — same resolved slots, so a slot approved in admin
 * shows up everywhere at once and the iTunes lookup for it only runs once
 * per boot rather than once per surface. Top tape mirrors the left rail,
 * bottom tape the right rail, same split `data-slot` naming trustmrr-style
 * marketplaces and CanIVibecodeIt both use it for: whichever rail a slot
 * would have landed in is the tape it appears in too.
 */
async function renderRails() {
  const left = document.getElementById('railLeft');
  const right = document.getElementById('railRight');
  // Empty slots need no network, so they paint immediately.
  left.innerHTML = RAIL_LEFT.map(() => emptySlot('left')).join('');
  right.innerHTML = RAIL_RIGHT.map(() => emptySlot('right')).join('');
  fillRailHeight(left);
  fillRailHeight(right);
  markWrappedNames(left);
  markWrappedNames(right);

  const { left: leftApps, right: rightApps } = await fetchSponsorSlots({
    staticLeft: RAIL_LEFT,
    staticRight: RAIL_RIGHT,
  });

  left.innerHTML = leftApps.map((app) => (app ? railCard(app) : emptySlot('left'))).join('');
  right.innerHTML = rightApps.map((app) => (app ? railCard(app) : emptySlot('right'))).join('');
  fillRailHeight(left);
  fillRailHeight(right);
  markWrappedNames(left);
  markWrappedNames(right);

  // Top tape mirrors the left rail, bottom tape the right — see the
  // function doc above for why the split follows that pairing.
  mountTape(document.getElementById('landingTapeTop'), leftApps.filter(Boolean), '#sponsor-left');
  mountTape(document.getElementById('landingTapeBottom'), rightApps.filter(Boolean), '#sponsor-right');
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

  const realCount = rail.children.length;
  const targetCount = Math.max(realCount, Math.round((available + gap) / (IDEAL_RAIL_CARD_HEIGHT + gap)));
  const side = railSide(rail);

  for (let i = realCount; i < targetCount; i++) {
    const filler = document.createElement('a');
    filler.className = 'rail-card empty';
    filler.dataset.filler = '';
    filler.href = `#sponsor-${side}`;
    filler.innerHTML = `
      <span class="rail-tag">Available</span>
      <span class="rail-name">Your app here</span>
      <span class="rail-desc">Claim this slot.</span>`;
    rail.appendChild(filler);
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

/** The `DEMO_LEADERBOARD` rows that carry a real catalogue id — the site
 * owner's own apps — computed once since the source data never changes at
 * runtime. `ITunesClient` caches per session, so calling `fillAppFacts`
 * with this on every sort/window toggle re-hits the cache rather than the
 * network after the first resolve. */
const DEMO_LINKED_APPS = DEMO_LEADERBOARD.map((e) => e.ownApp).filter((a) => a && typeof a === 'object');

async function refreshBoard() {
  const more = document.getElementById('lbMore');

  if (!board.client?.configured) {
    // The sample board has a fixed number of rows; once they are all shown
    // there is nothing further to reveal.
    renderBoard(sortedDemo());
    fillAppFacts(DEMO_LINKED_APPS);
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
  document.querySelectorAll('#leaderboard .seg-btn').forEach((btn) => {
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

function wireFooterBrand() {
  document.getElementById('footerBrand')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

/** `#sponsor`/`#sponsor-left`/`#sponsor-right` are the only hashes that
 * open the sponsor view — exact match, not a prefix check, so this never
 * fires for `#slots` (the hero-nav's own in-page anchor) or any of the
 * page's real anchors (`#leaderboard`, `#tools`, `#faq`). A plain hash link
 * never triggers a network navigation on the page it's already on, so
 * `#landingHome`'s rails are never recreated by opening this — only their
 * `hidden` attribute, and the sponsor view's, ever change. */
const SPONSOR_HASHES = new Set(['#sponsor', '#sponsor-left', '#sponsor-right']);
const BROWSE_HASHES = new Set(['#browse-testing', '#browse-launched']);

function applyPageHash() {
  const hash = location.hash;
  if (SPONSOR_HASHES.has(hash)) {
    hideBrowseView();
    showSponsorView(hash === '#sponsor-left' ? 'left' : hash === '#sponsor-right' ? 'right' : null);
    return;
  }
  if (BROWSE_HASHES.has(hash)) {
    hideSponsorView();
    showBrowseView(hash === '#browse-launched' ? 'launch' : 'testing');
    return;
  }
  hideSponsorView();
  hideBrowseView();
}

function wirePageViews() {
  initSponsorView();
  initBrowseView();
  window.addEventListener('hashchange', applyPageHash);
  applyPageHash();
}

async function boot() {
  renderDemo();
  wireHeroSearch();
  wireBoardControls();
  wireRailResize();
  wireFooterBrand();
  wirePageViews();
  // Not awaited: the rails are decoration, and a slow catalogue lookup for
  // them must not hold up the live community data below.
  renderRails();

  const client = new CommunityClient();
  // Site-wide, not gated on the sponsor view being open — the live count
  // there is meant to read "on the site right now", not "looking at this
  // pitch right now".
  startPresencePing(client, 'landing');
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

  if (listings.status === 'fulfilled') {
    mergeListingPlatforms(listings.value);
    renderLiveListings(listings.value);
  }

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
