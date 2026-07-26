/** The bundled specification catalogue, with its provenance. */

import { el, escapeHtml, pill, tablePanel } from './shared.js';

const STATUS_TONE = { required: 'ok', accepted: 'info', legacy: 'warn', deprecated: 'bad' };

export function initSpecs(specs) {
  const sections = [];

  for (const [store, spec] of Object.entries(specs.stores)) {
    const name = store === 'apple' ? 'App Store' : 'Google Play';
    sections.push(
      tablePanel({
        title: name,
        sub: `verified ${spec.last_verified}`,
        head: ['Device class', { label: 'Size', num: true }, 'Status', 'Notes'],
        rows: spec.sizes.map((size) => [
          { html: `<strong>${escapeHtml(size.device_class)}</strong>` },
          { html: `<span class="mono">${size.width} × ${size.height}</span>`, num: true },
          { html: pill(size.status, STATUS_TONE[size.status] ?? 'neutral') },
          { html: `<span class="muted">${escapeHtml(size.notes ?? '')}</span>` },
        ]),
      }) +
        `<p class="note">Source:
         <a href="${escapeHtml(spec.source_url)}" target="_blank" rel="noopener">official documentation</a>.</p>`,
    );
  }

  const market = specs.market;
  sections.push(
    tablePanel({
      title: 'Niche scoring methodology',
      sub: `v${market.version} · weights sum to ${market.signals.reduce((a, s) => a + s.weight, 0).toFixed(2)}`,
      head: ['Signal', 'Reads', { label: 'Weight', num: true }],
      rows: market.signals.map((s) => [
        { html: `<strong>${escapeHtml(s.label)}</strong>` },
        { html: `<code>${escapeHtml(s.aggregate)}</code>` },
        { html: `<span class="mono">${s.weight.toFixed(2)}</span>`, num: true },
      ]),
    }) +
      `<p class="note">Every signal is published here on purpose. The dominant industry
       metric — Apple Search Ads popularity — has no published methodology and no changelog,
       which is exactly why this one does.</p>`,
  );

  const limits = specs.listing_limits;
  sections.push(
    tablePanel({
      title: 'Listing field limits',
      head: ['Store', 'Field', { label: 'Maximum', num: true }, 'Required'],
      rows: Object.entries(limits).flatMap(([store, fields]) =>
        Object.entries(fields).map(([, limit]) => [
          store === 'apple' ? 'App Store' : 'Google Play',
          { html: `<strong>${escapeHtml(limit.name)}</strong>` },
          { html: `<span class="mono">${limit.max_length}</span>`, num: true },
          { html: limit.required ? pill('required', 'info') : '<span class="muted">optional</span>' },
        ]),
      ),
    }),
  );

  el('specsBody').innerHTML = sections.join('');
}
