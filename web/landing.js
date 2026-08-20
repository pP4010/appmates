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

function metric(label, value, tone = '', icon = '') {
  const iconHtml = icon ? `<img class="metric-icon" src="${icon}" alt="" width="17" height="17">` : '';
  return `<div><span class="k">${escapeHtml(label)}</span><span class="v ${tone}">${escapeHtml(String(value))}${iconHtml}</span></div>`;
}

/** Alternates the featured tint across a page's featured cards. A counter
 * rather than anything derived from the card itself: the obvious shortcuts
 * (name length, row index) are only *usually* alternating, and the first
 * version of this shipped three warm cards in a row because all three names
 * happened to have odd length. */
let featuredSeen = 0;

function tile({ flag, flagClass, name, genre, note, metrics, featured = false, boostTier = 0 }) {
  const featuredClass = featured ? ` featured${featuredSeen++ % 2 ? ' warm' : ''}` : '';
  const boostClass = boostTier ? ` boost-${boostTier}` : '';
  return `
    <a class="listing-tile${featuredClass}${boostClass}" href="./app.html#community">
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
          metric('High 5s', a.helped, '', './assets/darkHighFive.png'),
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
 * between them can't quietly drop a column.
 *
 * `ownApp` is a plain string for the fictional sample rows, but a `{ name,
 * trackId, country }` object for the two real ones — see `DEMO_LEADERBOARD`.
 * Only the latter gets a `ratingsKey`, which is what tells `renderBoard`
 * to render the `data-app`/`data-ratings` hooks `fillAppFacts` patches once
 * the catalogue lookup for that row resolves. */
function demoToRow(e) {
  const linked = e.ownApp && typeof e.ownApp === 'object';
  return {
    rank: e.rank,
    name: e.name,
    sub: `Helped ${e.apps} app${e.apps === 1 ? '' : 's'} ship`,
    appName: linked ? e.ownApp.name : e.ownApp,
    appDesc: e.ownAppDesc,
    tests: e.tests,
    ratings: e.ratings,
    ratingsKey: linked ? e.ownApp.trackId : null,
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
            boostTier: l.ownerBoostTier ?? 0,
            metrics: [
              metric('Testers', `${l.slotsFilled}/${l.slotsWanted || '∞'}`),
              metric('High 5s', l.ownerContribution ?? 0, '', './assets/darkHighFive.png'),
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
            boostTier: l.ownerBoostTier ?? 0,
            metrics: [
              metric('High 5s', l.ownerContribution ?? 0, '', './assets/darkHighFive.png'),
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
  fillAppFacts(testers.map((e) => e.ownApp).filter(Boolean));
}

/**
 * Reads each listed app's icon, real title, category and rating count
 * straight from the public catalogue, one throttled lookup at a time, and
 * patches the row(s) already on the board for that `trackId` — live testers
 * and the two self-promoted `DEMO_LEADERBOARD` rows alike, since both went
 * through `demoToRow`/`renderBoard` and carry the same `data-app`/
 * `data-ratings` hooks. Per-row failures leave the letter tile, the label
 * this file was given, and a dash — never a spinner that never resolves.
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
      const name = cell.querySelector('.lb-app');
      if (name && entry.trackName) name.textContent = entry.trackName;
      const desc = cell.querySelector('.lb-app-desc');
      if (desc) desc.textContent = entry.primaryGenreName ?? '';
    });
  }
}

/* ============================ promoted rails ============================ */

function railCard(app) {
  const colorClass = app.color ? ` rail-card--${escapeHtml(app.color)}` : '';
  return `
    <a class="rail-card${colorClass}" href="${escapeHtml(app.storeUrl)}" target="_blank" rel="noopener">
      ${app.artwork ? `<img class="rail-icon" src="${escapeHtml(app.artwork)}" alt="" loading="lazy">` : ''}
      <span class="rail-name">${escapeHtml(app.name)}</span>
      ${app.genre ? `<span class="rail-genre">${escapeHtml(app.genre)}</span>` : ''}
    </a>`;
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
  left.innerHTML = RAIL_LEFT.map(() => emptySlot()).join('');
  right.innerHTML = RAIL_RIGHT.map(() => emptySlot()).join('');
  fillRailHeight(left);
  fillRailHeight(right);
  markWrappedNames(left);
  markWrappedNames(right);

  const { left: leftApps, right: rightApps } = await fetchSponsorSlots({
    staticLeft: RAIL_LEFT,
    staticRight: RAIL_RIGHT,
  });

  left.innerHTML = leftApps.map((app) => (app ? railCard(app) : emptySlot())).join('');
  right.innerHTML = rightApps.map((app) => (app ? railCard(app) : emptySlot())).join('');
  fillRailHeight(left);
  fillRailHeight(right);
  markWrappedNames(left);
  markWrappedNames(right);

  const tapeMailto = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('Featuring my app on AppMates')}`;
  mountTape(document.getElementById('landingTapeTop'), leftApps.filter(Boolean), tapeMailto);
  mountTape(document.getElementById('landingTapeBottom'), rightApps.filter(Boolean), tapeMailto);
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

  for (let i = realCount; i < targetCount; i++) {
    const filler = document.createElement('a');
    filler.className = 'rail-card empty';
    filler.dataset.filler = '';
    filler.href = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('Featuring my app on AppMates')}`;
    filler.innerHTML = `
      <span class="rail-tag">Available</span>
      <span class="rail-name">Your app here</span>
      <span class="rail-desc">Get in touch to take this slot.</span>`;
    rail.appendChild(filler);
  }
}

/* ============================ promo dialog ============================ */

/** The palette an open slot can be requested in — muted, deep tones rather
 * than a bright candy palette, closer to what a marketplace like
 * trustmrr.com uses for its sponsor cards. Kept in sync by hand with the
 * `.rail-card--*` rules in `landing.css` — ten is few enough that a shared
 * lookup table would cost more to read than it saves. */
const RAIL_COLORS = [
  { id: 'blue', label: 'Blue', hex: '#2f5fa8' },
  { id: 'green', label: 'Green', hex: '#1f7a4d' },
  { id: 'violet', label: 'Violet', hex: '#6d3aa8' },
  { id: 'orange', label: 'Orange', hex: '#b5502a' },
  { id: 'pink', label: 'Pink', hex: '#8a2f4a' },
  { id: 'teal', label: 'Teal', hex: '#2c6470' },
  { id: 'red', label: 'Red', hex: '#a8342f' },
  { id: 'amber', label: 'Amber', hex: '#a87e1f' },
  { id: 'indigo', label: 'Indigo', hex: '#4340a0' },
  { id: 'slate', label: 'Slate', hex: '#4a5568' },
];

const PROMO_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function promoMailto({ color, app, name, email, message }) {
  const subject = `Featuring ${app?.name ?? 'my app'} on AppMates`;
  const body = [
    `App: ${app?.name ?? '(not provided)'}${app?.storeUrl ? ` — ${app.storeUrl}` : ''}`,
    `Preferred card colour: ${color}`,
    `Name: ${name || '(not provided)'}`,
    `Email: ${email || '(not provided)'}`,
    '',
    message || '(no message)',
  ].join('\n');
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function onPromoKeydown(e) {
  if (e.key === 'Escape') closePromoDialog();
}

function closePromoDialog() {
  document.getElementById('promoModal')?.remove();
  document.removeEventListener('keydown', onPromoKeydown);
}

/** Swaps the preview card's icon between the placeholder emoji and a real
 * `<img>` — the same span-to-img swap `fillAppFacts` does for a resolved
 * leaderboard row, just local to this one card instead of every row on a
 * page sharing a `data-app` key. */
function setPromoPreviewIcon(preview, artworkUrl) {
  const existing = preview.querySelector('.promo-preview-icon, .rail-icon');
  const node = artworkUrl ? document.createElement('img') : document.createElement('span');
  if (artworkUrl) {
    node.className = 'rail-icon';
    node.src = artworkUrl;
    node.alt = '';
  } else {
    node.className = 'promo-preview-icon';
    node.setAttribute('aria-hidden', 'true');
    node.textContent = '📱';
  }
  existing.replaceWith(node);
}

/**
 * Two steps in one overlay — reuses the app's own `.modal-overlay`/`.modal`/
 * `.field` look (see `views/community.js`'s "request to test" dialog)
 * rather than a landing-page-only component, so the two feel like the same
 * product. Each step wholesale-replaces `overlay.innerHTML`, which both
 * rebuilds its own listeners and discards the previous step's — simpler
 * than tracking two parallel sets of handlers on the same nodes. State that
 * has to survive the swap (`selected`, `resolvedApp`, `appQuery`) lives in
 * this function's closure, not in the DOM.
 *
 * Step one is the pitch: a live preview (icon/name/category resolved from
 * the App Store the same way the rails themselves are), a colour, and the
 * price. Step two only exists once a real app has resolved — you can't ask
 * for a slot for an app nobody can identify — and asks for the context a
 * human reviewer needs: who's asking, and why. Nothing here auto-publishes
 * anything; a request lands as `pending` for manual approval (see
 * `views/admin.js`), same as the pricing note already promises nothing is
 * auto-charged.
 */
function openPromoDialog() {
  let selected = RAIL_COLORS[0].id;
  let resolvedApp = null; // { name, genre, artwork, storeUrl, trackId }
  let appQuery = '';

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'promoModal';
  document.body.appendChild(overlay);

  const itunes = new ITunesClient(itunesRelayOptions());
  const community = new CommunityClient();
  let lookupTimer;

  function renderPitchStep() {
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="promoTitle">
        <div class="modal-head">
          <div>
            <h3 id="promoTitle">Feature your app here</h3>
            <p class="modal-sub">A promoted slot in the sidebar, linked straight to your store listing.</p>
          </div>
          <button class="modal-close" type="button" aria-label="Close">✕</button>
        </div>

        <div class="promo-preview-wrap">
          <div class="rail-card rail-card--${selected}" id="promoPreviewCard" aria-label="Card preview">
            <span class="promo-preview-icon" aria-hidden="true">📱</span>
            <span class="rail-name">Your app</span>
            <span class="rail-genre">Category</span>
          </div>
        </div>

        <div class="field">
          <label for="promoAppInput">Your app</label>
          <input id="promoAppInput" type="text" placeholder="1438388363 or com.example.app" autocomplete="off">
          <span class="promo-app-status" id="promoAppStatus"></span>
        </div>

        <div class="field">
          <label id="promoColorLabel">Card colour</label>
          <div class="promo-swatches" role="radiogroup" aria-labelledby="promoColorLabel">
            ${RAIL_COLORS.map(
              (c) => `
              <button type="button" class="promo-swatch${c.id === selected ? ' selected' : ''}"
                data-color="${c.id}" style="--swatch:${c.hex}"
                role="radio" aria-checked="${c.id === selected}" aria-label="${escapeHtml(c.label)}"></button>`,
            ).join('')}
          </div>
        </div>

        <div class="promo-price">
          <span class="promo-price-old">$20/mo</span>
          <span class="promo-price-new">Free</span>
        </div>
        <p class="modal-sub">
          Free while AppMates is growing. As traffic and demand pick up, pricing may
          change — at most once a month, never mid-cycle — but you'll always hear about
          it first by email. Nothing is ever charged without your confirmation.
        </p>

        <button type="button" id="promoRequestBtn" class="landing-cta" style="width:100%;margin-top:.4rem">
          Request this slot
        </button>
      </div>`;

      const modal = overlay.querySelector('.modal');
      const preview = modal.querySelector('#promoPreviewCard');
      const requestBtn = modal.querySelector('#promoRequestBtn');
      const appInput = modal.querySelector('#promoAppInput');
      const appStatus = modal.querySelector('#promoAppStatus');
      appInput.value = appQuery;

      const applyResolved = (entry) => {
        preview.querySelector('.rail-name').textContent = entry ? entry.name : 'Your app';
        preview.querySelector('.rail-genre').textContent = entry ? entry.genre : 'Category';
        setPromoPreviewIcon(preview, entry ? entry.artwork : '');
      };
      if (resolvedApp) {
        applyResolved(resolvedApp);
        appStatus.textContent = `Found: ${resolvedApp.name}`;
      }

      modal.querySelectorAll('.promo-swatch').forEach((btn) => {
        btn.addEventListener('click', () => {
          modal.querySelectorAll('.promo-swatch').forEach((b) => {
            b.classList.remove('selected');
            b.setAttribute('aria-checked', 'false');
          });
          btn.classList.add('selected');
          btn.setAttribute('aria-checked', 'true');
          selected = btn.dataset.color;
          preview.className = `rail-card rail-card--${selected}`;
        });
      });

      appInput.addEventListener('input', () => {
        clearTimeout(lookupTimer);
        appQuery = appInput.value.trim();
        appStatus.classList.remove('error');

        if (!appQuery) {
          resolvedApp = null;
          appStatus.textContent = '';
          applyResolved(null);
          return;
        }

        appStatus.textContent = 'Looking up…';
        lookupTimer = setTimeout(async () => {
          let entry = null;
          try {
            entry = await itunes.lookup(appQuery, { country: 'us' });
          } catch {
            appStatus.textContent = "Couldn't reach the App Store catalogue — try again in a moment.";
            return;
          }
          if (!entry) {
            resolvedApp = null;
            appStatus.textContent = "Couldn't find that app — check the id.";
            return;
          }
          resolvedApp = {
            trackId: String(entry.trackId ?? appQuery),
            name: entry.trackName,
            genre: entry.primaryGenreName ?? '',
            artwork: entry.artworkUrl100 ?? entry.artworkUrl512 ?? '',
            storeUrl: entry.trackViewUrl ?? '',
          };
          appStatus.textContent = `Found: ${entry.trackName}`;
          applyResolved(resolvedApp);
        }, 500);
      });

      requestBtn.addEventListener('click', () => {
        if (!resolvedApp) {
          appStatus.textContent = 'Add a valid app above first.';
          appStatus.classList.add('error');
          appInput.focus();
          return;
        }
        renderConfirmStep();
      });

      modal.querySelector('.modal-close').addEventListener('click', closePromoDialog);
  }

  function renderConfirmStep() {
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="promoConfirmTitle">
        <div class="modal-head">
          <div>
            <h3 id="promoConfirmTitle">Confirm your request</h3>
            <p class="modal-sub">I review every request by hand — this is what I read to decide.</p>
          </div>
          <button class="modal-close" type="button" aria-label="Close">✕</button>
        </div>

        <div class="promo-preview-wrap">
          <div class="rail-card rail-card--${selected} promo-shine" aria-label="Card preview">
            ${resolvedApp.artwork ? `<img class="rail-icon" src="${escapeHtml(resolvedApp.artwork)}" alt="">` : '<span class="promo-preview-icon" aria-hidden="true">📱</span>'}
            <span class="rail-name">${escapeHtml(resolvedApp.name)}</span>
            ${resolvedApp.genre ? `<span class="rail-genre">${escapeHtml(resolvedApp.genre)}</span>` : ''}
          </div>
        </div>

        <div class="field">
          <label for="promoName">Your name</label>
          <input id="promoName" type="text" placeholder="Jane Doe" autocomplete="name">
        </div>
        <div class="field">
          <label for="promoEmail">Your email</label>
          <input id="promoEmail" type="email" placeholder="you@example.com" autocomplete="email">
        </div>
        <div class="field">
          <label for="promoMessage">What's your app about?</label>
          <textarea id="promoMessage" rows="4"
            placeholder="What it does, who it's for, and why you'd like a slot here. If there are more requests than open slots, this is what decides it."></textarea>
        </div>

        <div id="promoSendStatus" class="status"></div>

        <div style="display:flex;gap:.6rem;margin-top:.6rem">
          <button type="button" id="promoBackBtn">Back</button>
          <button type="button" id="promoSendBtn" class="primary" style="flex:1">Send request</button>
        </div>
      </div>`;

    const modal = overlay.querySelector('.modal');
    modal.querySelector('.modal-close').addEventListener('click', closePromoDialog);
    modal.querySelector('#promoBackBtn').addEventListener('click', renderPitchStep);
    modal.querySelector('#promoSendBtn').addEventListener('click', () => submitPromoRequest(modal, community));
  }

  async function submitPromoRequest(modal, communityClient) {
    const name = modal.querySelector('#promoName').value.trim();
    const email = modal.querySelector('#promoEmail').value.trim();
    const message = modal.querySelector('#promoMessage').value.trim();
    const status = modal.querySelector('#promoSendStatus');
    const sendBtn = modal.querySelector('#promoSendBtn');

    if (!name) return showSendError(status, 'Your name is required.');
    if (!PROMO_EMAIL_RE.test(email)) return showSendError(status, 'A valid email is required.');
    if (message.length < 20) {
      return showSendError(status, 'Say a bit more — at least 20 characters helps me understand your app.');
    }

    sendBtn.disabled = true;
    status.className = 'status';
    status.textContent = 'Sending…';

    if (communityClient.configured) {
      try {
        await communityClient.submitPromoRequest({
          trackId: resolvedApp.trackId,
          name: resolvedApp.name,
          genre: resolvedApp.genre,
          artworkUrl: resolvedApp.artwork,
          storeUrl: resolvedApp.storeUrl,
          color: selected,
          message,
          requesterName: name,
          email,
        });
        status.className = 'status ok';
        status.textContent = "Sent — I'll email you either way once I've reviewed it.";
        sendBtn.textContent = 'Sent';
        return;
      } catch (err) {
        // Falls through to the `mailto` handoff below rather than leaving
        // the visitor stuck on a dead button — the backend rejecting or
        // being unreachable shouldn't cost them the request entirely.
        status.textContent = `Couldn't submit directly (${err.message}) — opening your email app instead.`;
      }
    }

    window.location.href = promoMailto({ color: selected, app: resolvedApp, name, email, message });
    status.className = 'status ok';
    status.textContent = 'Opened in your email app — send it to finish the request.';
    sendBtn.disabled = false;
  }

  function showSendError(status, message) {
    status.className = 'status error';
    status.textContent = message;
  }

  renderPitchStep();

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePromoDialog();
  });
  document.addEventListener('keydown', onPromoKeydown);
}

/** Delegated rather than bound per-card: filler cards are (re)created by
 * `fillRailHeight` on every resize, and a listener attached to elements
 * that get thrown away and rebuilt would silently stop firing. */
function wirePromoDialog() {
  document.addEventListener('click', (e) => {
    const card = e.target.closest('.rail-card.empty');
    if (!card) return;
    e.preventDefault();
    openPromoDialog();
  });
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
  wirePromoDialog();
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
