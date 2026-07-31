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

function tile({ flag, flagClass, name, genre, note, metrics }) {
  return `
    <a class="listing-tile" href="./app.html#community">
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
  document.getElementById('rowTesting').innerHTML =
    DEMO_TESTING.map((a) =>
      tile({
        flag: 'NEEDS TESTERS',
        flagClass: 'testing',
        name: a.name,
        genre: a.genre,
        note: a.note,
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
        metrics: [
          metric('Health', a.health, healthTone(a.health)),
          metric('Rating', `${a.rating}★`),
          metric('Ratings', a.ratings),
        ].join(''),
      }),
    ).join('') + moreTile('See every launch and update');

  document.getElementById('lbBody').innerHTML = DEMO_LEADERBOARD.map(
    (e) => `
      <tr>
        <td class="c">${e.rank <= 3 ? `<span class="lb-medal">${MEDALS[e.rank - 1]}</span>` : `<span class="lb-rank">${e.rank}</span>`}</td>
        <td><span class="lb-who">${letterTile(e.name)}<span class="lb-name">${escapeHtml(e.name)}</span></span></td>
        <td class="n apps-col">${e.tests}</td>
        <td class="n"><span class="lb-tokens">${e.tokens}</span></td>
      </tr>`,
  ).join('');
}

/* ============================ live rendering ============================ */

/** Per section, never wholesale: a live listings row does not make the
 * leaderboard beside it real, and dropping its tag too would relabel sample
 * numbers as traction. */
function clearDemoTag(section) {
  document.querySelector(`[data-demo="${section}"]`)?.remove();
}

function renderLiveListings(listings) {
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
  document.getElementById('lbBody').innerHTML = testers
    .slice(0, 7)
    .map(
      (e) => `
      <tr>
        <td class="c">${e.rank <= 3 ? `<span class="lb-medal">${MEDALS[e.rank - 1]}</span>` : `<span class="lb-rank">${e.rank}</span>`}</td>
        <td><span class="lb-who">${letterTile(e.displayName)}<span class="lb-name">${escapeHtml(e.displayName)}</span></span></td>
        <td class="n apps-col">${e.completedCount}</td>
        <td class="n"><span class="lb-tokens">${e.tokensEarned}</span></td>
      </tr>`,
    )
    .join('');
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

async function boot() {
  renderDemo();
  wireHeroSearch();

  const client = new CommunityClient();
  if (!client.configured) return;

  // Independent on purpose: a leaderboard outage should not also cost the
  // page its listings, so each half settles on its own.
  const [listings, board] = await Promise.allSettled([
    client.browseListings(undefined, 'newest'),
    client.leaderboard(),
  ]);

  if (listings.status === 'fulfilled') renderLiveListings(listings.value);
  if (board.status === 'fulfilled') renderLiveLeaderboard(board.value.testers);
}

boot().catch(() => {
  /* The static half of the page still stands. */
});
