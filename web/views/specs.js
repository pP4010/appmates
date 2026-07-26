/** The bundled specification catalogue, with its provenance. */

import { el, escapeHtml, table } from './shared.js';

export function initSpecs(specs) {
  const sections = [];

  for (const [store, spec] of Object.entries(specs.stores)) {
    const name = store === 'apple' ? 'App Store' : 'Google Play';
    const rows = spec.sizes.map((size) => [
      escapeHtml(size.device_class),
      { html: `${size.width} × ${size.height}`, num: true },
      { html: statusBadge(size.status) },
      escapeHtml(size.notes ?? ''),
    ]);

    sections.push(`
      <h2>${name}</h2>
      <p class="note">Verified ${escapeHtml(spec.last_verified)} against
        <a href="${escapeHtml(spec.source_url)}" target="_blank" rel="noopener">the official documentation</a>.</p>
      ${table({
        head: ['Device class', { label: 'Size', num: true }, 'Status', 'Notes'],
        rows,
      })}`);
  }

  const market = specs.market;
  sections.push(`
    <h2>Niche scoring</h2>
    <p class="note">Methodology v${escapeHtml(market.version)}, verified
      ${escapeHtml(market.last_verified)}. Weights sum to
      ${market.signals.reduce((a, s) => a + s.weight, 0).toFixed(2)}.</p>
    ${table({
      head: ['Signal', 'Reads', { label: 'Weight', num: true }],
      rows: market.signals.map((s) => [
        escapeHtml(s.label),
        `<code>${escapeHtml(s.aggregate)}</code>`,
        { html: s.weight.toFixed(2), num: true },
      ]),
    })}
    <p class="note">Every signal is published here on purpose. The dominant
      industry metric — Apple Search Ads popularity — has no published
      methodology and no changelog, which is exactly why this one does.</p>`);

  el('specsBody').innerHTML = sections.join('');
}

function statusBadge(status) {
  const tone = { required: 'pass', accepted: 'pass', legacy: 'warn', deprecated: 'fail' }[status];
  return `<span class="badge ${tone ?? 'warn'}">${escapeHtml(status)}</span>`;
}
