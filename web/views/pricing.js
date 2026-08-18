/** Suggested per-territory prices from one base price. */

import { getPricingSpec, suggestPrices } from '../lib/pricing.js';
import { el, empty, escapeHtml, pill, tablePanel } from './shared.js';

export function initPricing() {
  populateModelSelect();
  el('prBase').addEventListener('input', render);
  el('prModel').addEventListener('change', render);
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

  el('prResults').innerHTML = tablePanel({
    title: 'Suggested prices',
    sub: spec.models[model]?.description ?? '',
    head: ['Storefront', 'Tier', { label: 'Multiplier', num: true }, { label: 'Suggested price', num: true }],
    rows: prices.map((p) => [
      `${p.countryName} (${p.country.toUpperCase()})`,
      { html: p.tierLabel ? pill(p.tierLabel, 'neutral') : pill('unclassified — full rate', 'neutral') },
      { html: `${p.multiplier.toFixed(2)}×`, num: true },
      { html: `<strong>${p.suggestedPrice.toFixed(2)}</strong>`, num: true },
    ]),
  });
}
