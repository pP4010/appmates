/** Which storefront a term is actually winnable in. */

import { scanMarkets, defaultStorefronts } from '../lib/market.js';
import { el, empty, escapeHtml, flagEmoji, pill, ring, tablePanel, withStatus } from './shared.js';

const TONE = { open: 'ok', contested: 'warn', locked: 'bad' };

export function initMarkets(client) {
  el('marketsRun').addEventListener('click', () => run(client));
  el('marketsResults').innerHTML = empty(
    '⊕',
    'No scan yet',
    'A term locked in the United States is routinely open somewhere else.',
  );
}

async function run(client) {
  const keyword = el('marketsKeyword').value.trim();
  const results = el('marketsResults');

  if (!keyword) {
    results.innerHTML = empty('⊕', 'No search term', 'Enter a term to scan across storefronts.');
    return;
  }

  const raw = el('marketsCountries').value.trim();
  const countries = raw
    ? raw.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean)
    : defaultStorefronts();

  const report = await withStatus(el('marketsStatus'), el('marketsRun'), results, (say) =>
    scanMarkets(client, keyword, countries, {
      onProgress: (code, index, total) => say(`${code.toUpperCase()} — ${index} of ${total}`),
    }),
  );

  if (!report) return;
  results.innerHTML = render(report);
}

function render(report) {
  const rows = report.ranked.map((result) => {
    if (!result.report) {
      return [
        { html: `<span class="muted">${flagEmoji(result.country)} ${escapeHtml(result.countryName)}</span>` },
        { html: `<span class="muted">${result.country.toUpperCase()}</span>` },
        { html: '<span class="muted">—</span>', center: true },
        { html: pill('no data', 'neutral') },
        { html: '', num: true },
      ];
    }
    const depth = result.report.signals.find((s) => s.code === 'COMPETITIVE_DEPTH')?.observed ?? 0;
    return [
      { html: `<strong>${flagEmoji(result.country)} ${escapeHtml(result.countryName)}</strong>` },
      { html: `<span class="muted mono">${result.country.toUpperCase()}</span>` },
      { html: ring(result.report.winnability, { size: 34, stroke: 3.5, thresholds: [60, 35] }), tight: true, center: true },
      { html: pill(result.report.verdict, TONE[result.report.verdict]) },
      { html: String(Math.round(depth)), num: true },
    ];
  });

  const usable = report.ranked.filter((r) => r.report);
  let headline = '';
  if (report.verdictsDiffer && usable.length) {
    const best = usable[0];
    const worst = usable[usable.length - 1];
    headline = `
      <div class="callout">
        This term is <strong>${best.report.verdict.toUpperCase()}</strong> in
        ${escapeHtml(best.countryName)} and
        <strong>${worst.report.verdict.toUpperCase()}</strong> in
        ${escapeHtml(worst.countryName)}.<br>
        Which storefront you lead with is a bigger lever here than anything you can do to
        the listing itself.
      </div>`;
  } else if (usable.length) {
    headline = `<p class="note">Every storefront lands on
      ${usable[0].report.verdict.toUpperCase()} within ${report.spread.toFixed(0)} points —
      this term is about as hard everywhere.</p>`;
  }

  const reduced = report.reducedCountries?.length
    ? `<p class="note">Your connection could not fetch the full result page for
       ${report.reducedCountries.map((c) => c.toUpperCase()).join(', ')}, so those scored on a
       smaller sample.</p>`
    : '';
  const failed = report.failedCountries.length
    ? `<p class="note">No data for ${report.failedCountries.map((c) => c.toUpperCase()).join(', ')}.</p>`
    : '';

  return (
    headline +
    tablePanel({
      title: report.keyword,
      sub: `${report.results.length} storefronts`,
      head: ['Storefront', '', { label: 'Winnability', center: true }, 'Verdict', { label: 'Credible rivals', num: true }],
      rows,
    }) +
    reduced +
    failed
  );
}
