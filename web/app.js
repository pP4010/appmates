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

const VIEWS = [
  'screenshots',
  'keywords',
  'metadata',
  'niche',
  'markets',
  'competitors',
  'rank',
  'testers',
  'specs',
];

function route() {
  const name = (location.hash || '#screenshots').slice(1);
  const active = VIEWS.includes(name) ? name : 'screenshots';

  for (const view of VIEWS) {
    document.getElementById(`view-${view}`)?.classList.toggle('active', view === active);
  }
  for (const link of document.querySelectorAll('.nav a')) {
    link.classList.toggle('active', link.getAttribute('href') === `#${active}`);
  }
  document.title = `LaunchPilot — ${active}`;
}

/** Populate every storefront picker from the generated spec. */
function fillCountrySelects() {
  const options = defaultStorefronts()
    .map((code) => `<option value="${code}">${countryName(code)}</option>`)
    .join('');
  for (const id of ['nicheCountry', 'compCountry', 'rankCountry']) {
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

  fillCountrySelects();

  // A single client so the throttle and cache are shared across every tool
  // rather than each view hammering Apple on its own schedule.
  const client = new ITunesClient();

  initScreenshots({ getSpec });
  initKeywords();
  initMetadata();
  initNiche(client);
  initMarkets(client);
  initCompetitors(client);
  initRank(client);
  initTesters();
  initSpecs(specs);

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
