/**
 * Application shell: routing, boot and view wiring.
 *
 * No rules live here. Every engine sits in lib/ and mirrors a Python service
 * that the conformance suite holds it to. This file only reads inputs, calls an
 * engine and renders the result.
 */

import { loadSpecs, getSpec } from './lib/validator.js';
import { loadAso } from './lib/keywords.js';
import { loadMarketSpec, defaultStorefronts, countryName } from './lib/market.js';
import { loadTestingSpec } from './lib/testers.js';
import { loadListingLimits } from './lib/metadata.js';
import { loadAppHealthSpec } from './lib/app-profile.js';
import { ITunesClient } from './lib/itunes.js';

import { initScreenshots } from './views/screenshots.js';
import { initKeywords } from './views/keywords.js';
import { initMetadata } from './views/metadata.js';
import { initNiche } from './views/niche.js';
import { initMarkets } from './views/markets.js';
import { initCompetitors } from './views/competitors.js';
import { initRank } from './views/rank.js';
import { initTesters } from './views/testers.js';
import { initSpecs } from './views/specs.js';
import { initOverview, selectedApp, loadApp } from './views/overview.js';
import { initFavoritesTray } from './views/favorites-tray.js';
import { initCommunity } from './views/community.js';
import { CommunityClient } from './lib/community.js';

/** Title and one-line purpose per view, shown in the top bar. */
const VIEWS = {
  overview: ['Overview', 'Your app, and what is left to fix'],
  screenshots: ['Screenshots', 'Validate and repair store assets'],
  keywords: ['Keyword field', 'Audit the 100 characters nobody sees'],
  metadata: ['Listing text', 'Field limits for both stores'],
  niche: ['Niche', 'Is this market worth entering?'],
  markets: ['Markets', 'Which storefront is it winnable in?'],
  competitors: ['Competitors', 'Who holds the term, and how they present'],
  rank: ['Rank', 'Your position per keyword, tracked locally'],
  testers: ['Play testers', 'The 12-for-14-days production gate'],
  community: ['Get testers', 'Real closed testers, and real users at launch'],
  specs: ['Specs', 'The bundled catalogue and its provenance'],
};

function route() {
  const name = (location.hash || '#overview').slice(1);
  const active = name in VIEWS ? name : 'overview';

  for (const view of Object.keys(VIEWS)) {
    document.getElementById(`view-${view}`)?.classList.toggle('active', view === active);
  }
  for (const link of document.querySelectorAll('.nav-item')) {
    link.classList.toggle('active', link.getAttribute('href') === `#${active}`);
  }

  const [title, sub] = VIEWS[active];
  document.getElementById('viewTitle').textContent = title;
  document.getElementById('viewSub').textContent = sub;
  document.title = `LaunchPilot — ${title}`;
  window.scrollTo({ top: 0 });
}

/** Populate every storefront picker from the generated spec. */
function fillCountrySelects() {
  const options = defaultStorefronts()
    .map((code) => `<option value="${code}">${countryName(code)}</option>`)
    .join('');
  for (const id of ['nicheCountry', 'compCountry', 'rankCountry', 'ovCountry']) {
    const select = document.getElementById(id);
    if (select) select.innerHTML = options;
  }
}

async function boot() {
  const specs = await (await fetch('./lib/specs.json')).json();

  // One catalogue of numbers, handed to every engine that needs part of it.
  loadSpecs(specs);
  loadAso(specs);
  loadMarketSpec(specs);
  loadTestingSpec(specs);
  loadListingLimits(specs);
  loadAppHealthSpec(specs);

  fillCountrySelects();

  // A single client so the throttle and cache are shared across every tool
  // rather than each view hammering Apple on its own schedule.
  const client = new ITunesClient();

  // The app card doubles as the selector: choosing one here prefills the tools
  // that need an id, which is the point of having a selection at all.
  const refreshAppCard = () => {
    const app = selectedApp();
    const mark = document.getElementById('appMark');
    document.getElementById('appName').textContent = app?.name ?? 'Select your app';
    document.getElementById('appSeller').textContent =
      app?.seller ?? 'LaunchPilot · pre-flight checks';
    mark.innerHTML = app?.artwork
      ? `<img src="${app.artwork}" alt="">`
      : '◈';
    if (app) {
      const rankInput = document.getElementById('rankApp');
      if (!rankInput.value) rankInput.value = String(app.bundleId || app.trackId);
      const mine = document.getElementById('compMine');
      if (!mine.value) mine.value = app.name;
      const kwTitle = document.getElementById('kwTitle');
      if (!kwTitle.value) kwTitle.value = app.name;
      const mdTitle = document.getElementById('mdTitle');
      if (!mdTitle.value) {
        mdTitle.value = app.name;
        mdTitle.dispatchEvent(new Event('input'));
      }
    }
  };

  initScreenshots({ getSpec });
  initKeywords();
  initMetadata();
  initNiche(client);
  initMarkets(client);
  initCompetitors(client);
  initRank(client);
  initTesters();
  initSpecs(specs);
  initOverview(client, { onAppChange: refreshAppCard });
  refreshAppCard();

  initFavoritesTray({
    onSelectApp: (appId, country) => {
      location.hash = '#overview';
      loadApp(appId, country);
    },
  });

  initCommunity(new CommunityClient(), { getCurrentApp: selectedApp });

  const apple = specs.stores.apple;
  const google = specs.stores.google;
  document.getElementById('provenance').textContent =
    `Specifications verified ${apple.last_verified} (App Store) and ` +
    `${google.last_verified} (Google Play) against the official documentation. ` +
    `Market scoring methodology v${specs.market.version}.`;

  window.addEventListener('hashchange', route);
  route();
}

boot().catch((err) => {
  document.querySelector('main').innerHTML =
    `<div class="summary fail"><span class="verdict">Failed to start</span> ` +
    `<span class="muted">${err.message}</span></div>`;
});
