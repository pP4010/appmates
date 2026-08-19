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
import { loadPricingSpec } from './lib/pricing.js';
import { ITunesClient } from './lib/itunes.js';
import { flagEmoji } from './views/shared.js';

import { initScreenshots } from './views/screenshots.js';
import { initKeywords } from './views/keywords.js';
import { initMetadata } from './views/metadata.js';
import { initReadiness } from './views/readiness.js';
import { initPricing } from './views/pricing.js';
import { initNiche } from './views/niche.js';
import { initMarkets } from './views/markets.js';
import { initCompetitors } from './views/competitors.js';
import { initRank } from './views/rank.js';
import { initTesters } from './views/testers.js';
import { initPrepare, initResearch, initTrack } from './views/launch.js';
import { initSpecs } from './views/specs.js';
import { initOverview, selectedApp, loadApp } from './views/overview.js';
import { initFavoritesTray } from './views/favorites-tray.js';
import { initCommunity } from './views/community.js';
import { initInbox } from './views/inbox.js';
import { initAdmin } from './views/admin.js';
import { CommunityClient, itunesRelayOptions } from './lib/community.js';

/** Title and one-line purpose per view, shown in the top bar.
 * `admin` has no `.nav-item` in the sidebar (see views/admin.js for why),
 * but still needs an entry here or `route()` would bounce `#admin` back
 * to overview. */
const VIEWS = {
  overview: ['Overview', 'Your app, and what is left to fix'],
  prepare: ['Prepare', 'Fix what a store would reject — with real App Store Connect data'],
  research: ['Research', 'Is this market worth entering, and where'],
  track: ['Track', 'Your rank over time, and every test you have running'],
  inbox: ['Inbox', 'Every conversation, in one place'],
  community: ['Get testers', 'Real closed testers, and real users at launch'],
  specs: ['Specs', 'The bundled catalogue and its provenance'],
  admin: ['Admin', 'Review "Feature your app here" requests'],
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
  document.title = `AppMates — ${title}`;
  window.scrollTo({ top: 0 });
}

/** Populate every storefront picker from the generated spec. */
function fillCountrySelects() {
  const options = defaultStorefronts()
    .map((code) => `<option value="${code}">${flagEmoji(code)} ${countryName(code)}</option>`)
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
  loadPricingSpec(specs);

  fillCountrySelects();

  // A single client so the throttle and cache are shared across every tool
  // rather than each view hammering Apple on its own schedule. Routes
  // through the community Worker's `/itunes/*` relay (see
  // `itunesRelayOptions` in lib/community.js) rather than straight from
  // the browser to Apple — a server-to-server fetch has no CORS story to
  // break, unlike a direct request to Apple's undocumented endpoint.
  const client = new ITunesClient(itunesRelayOptions());

  // The app card doubles as the selector: choosing one here prefills the tools
  // that need an id, which is the point of having a selection at all.
  const refreshAppCard = () => {
    const app = selectedApp();
    const mark = document.getElementById('appMark');
    document.getElementById('appName').textContent = app?.name ?? 'Select your app';
    document.getElementById('appSeller').textContent =
      app?.seller ?? 'AppMates · pre-flight checks';
    mark.innerHTML = app?.artwork
      ? `<img src="${app.artwork}" alt="">`
      : '<img src="./assets/icon.svg" alt="">';
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
  initReadiness();
  initPricing();
  initNiche(client);
  initMarkets(client);
  initCompetitors(client);
  initRank(client);
  initTesters();
  initPrepare();
  initResearch();
  initTrack();
  initSpecs(specs);
  initOverview(client, { onAppChange: refreshAppCard });
  refreshAppCard();

  initFavoritesTray({
    onSelectApp: (appId, country) => {
      location.hash = '#overview';
      loadApp(appId, country);
    },
  });

  // An id typed into the landing page's search box, handed over as `?app=`.
  // Consumed once and stripped from the URL so a reload — or a link someone
  // copied out of the address bar — doesn't silently re-run the lookup and
  // override whatever app they picked since.
  const handoff = new URLSearchParams(location.search).get('app');
  if (handoff) {
    history.replaceState(null, '', location.pathname + location.hash);
    location.hash = '#overview';
    loadApp(handoff);
  }

  // The same throttled iTunes client every tool shares, so listing cards can
  // re-derive an app's public catalogue facts rather than trusting numbers
  // the person who posted the listing typed in.
  const communityClient = new CommunityClient();
  initCommunity(communityClient, { getCurrentApp: selectedApp, itunes: client });
  initInbox(communityClient);
  initAdmin(communityClient);

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
  console.error(err);
  document.querySelector('.main').innerHTML =
    `<div class="summary fail"><span class="verdict">Failed to start</span> ` +
    `<span class="muted">${err.message}</span></div>`;
});
