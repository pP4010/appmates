/** Suggested per-territory prices from one base price. */

import { currentPriceFor, getPricingSpec, hasCurrentPrices, suggestPrices } from '../lib/pricing.js';
import { el, empty, escapeHtml, pill, tablePanel } from './shared.js';

export function initPricing() {
  populateModelSelect();
  el('prBase').addEventListener('input', render);
  el('prModel').addEventListener('change', render);
  // The Overview page's App Store Connect import sets current prices and
  // fires this rather than calling into this module directly — views stay
  // decoupled, the same way every other cross-view refresh here works
  // through a DOM event rather than an import.
  window.addEventListener('appmates:asc-prices', render);
  render();
}

function populateModelSelect() {
  const spec = getPricingSpec();
  el('prModel').innerHTML = Object.entries(spec.models)
    .map(([id, m]) => `<option value="${id}">${escapeHtml(m.label)}</option>`)
    .join('');
  el('prModel').value = 'ppp_tier';
}

function render() {
  const base = parseFloat(el('prBase').value);

  if (!base || base <= 0) {
    el('prResults').innerHTML = empty(
      '$',
      'Nothing to price yet',
      'Enter a base price to see suggested prices per storefront.',
    );
    return;
  }

  const spec = getPricingSpec();
  const model = el('prModel').value;
  const prices = suggestPrices(base, { model });
  const showCurrent = hasCurrentPrices();

  const head = ['Storefront', 'Tier', { label: 'Multiplier', num: true }];
  if (showCurrent) head.push({ label: 'Current (App Store Connect)', num: true });
  head.push({ label: 'Suggested price', num: true });

  el('prResults').innerHTML = tablePanel({
    title: 'Suggested prices',
    sub:
      spec.models[model]?.description +
      (showCurrent ? ' Current prices are what is live now, pulled via appmates asc pull.' : ''),
    head,
    rows: prices.map((p) => {
      const current = showCurrent ? currentPriceFor(p.country) : null;
      const row = [
        `${p.countryName} (${p.country.toUpperCase()})`,
        { html: p.tierLabel ? pill(p.tierLabel, 'neutral') : pill('unclassified — full rate', 'neutral') },
        { html: `${p.multiplier.toFixed(2)}×`, num: true },
      ];
      if (showCurrent) {
        row.push({ html: current !== null ? current : '<span class="muted">—</span>', num: true });
      }
      row.push({ html: `<strong>${p.suggestedPrice.toFixed(2)}</strong>`, num: true });
      return row;
    }),
  });
}
