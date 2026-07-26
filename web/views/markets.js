/** Which storefront a term is actually winnable in. */

import { scanMarkets, defaultStorefronts } from '../lib/market.js';
import { badge, el, escapeHtml, meter, table, withStatus } from './shared.js';

export function initMarkets(client) {
  el('marketsRun').addEventListener('click', () => run(client));
}

async function run(client) {
  const keyword = el('marketsKeyword').value.trim();
  const raw = el('marketsCountries').value.trim();
  const results = el('marketsResults');

  if (!keyword) {
    results.innerHTML = '<p class="note">Enter a search term.</p>';
    return;
  }

  const countries = raw
    ? raw.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean)
    : defaultStorefronts();

  const report = await withStatus(el('marketsStatus'), el('marketsRun'), (say) =>
    scanMarkets(client, keyword, countries, {
      onProgress: (code, index, total) => say(`${code.toUpperCase()} (${index}/${total})…`),
    }),
  );

  if (!report) return;
  results.innerHTML = renderScan(report);
}

function renderScan(report) {
  const rows = report.ranked.map((result) => {
    if (!result.report) {
      return [
        escapeHtml(result.countryName),
        result.country.toUpperCase(),
        { html: '<span class="muted">—</span>', num: true },
        { html: '<span class="muted">unavailable</span>' },
        { html: '<span class="muted">no data</span>' },
        { html: '', num: true },
      ];
    }
    const depth =
      result.report.signals.find((s) => s.code === 'COMPETITIVE_DEPTH')?.observed ?? 0;
    return [
      escapeHtml(result.countryName),
      result.country.toUpperCase(),
      { html: `<strong>${result.report.winnability.toFixed(0)}</strong>`, num: true },
      { html: meter(result.report.winnability, { width: 12, thresholds: [60, 35] }) },
      { html: badge(result.report.verdict, result.report.verdict) },
      { html: String(Math.round(depth)), num: true },
    ];
  });

  const usable = report.ranked.filter((r) => r.report);
  let verdictLine = '';
  if (report.verdictsDiffer && usable.length) {
    const best = usable[0];
    const worst = usable[usable.length - 1];
    verdictLine = `
      <div class="callout">
        This term is <strong>${best.report.verdict.toUpperCase()}</strong> in
        ${escapeHtml(best.countryName)} and
        <strong>${worst.report.verdict.toUpperCase()}</strong> in
        ${escapeHtml(worst.countryName)}.
        <br><span class="muted">Which storefront you lead with is a bigger lever
        here than anything you can do to the listing itself.</span>
      </div>`;
  } else if (usable.length) {
    verdictLine = `
      <p class="note">Every storefront lands on
      ${usable[0].report.verdict.toUpperCase()} within ${report.spread.toFixed(0)}
      points — this term is about as hard everywhere.</p>`;
  }

  const reduced = report.reducedCountries?.length
    ? `<p class="note">Your connection could not fetch the full result page for
       ${report.reducedCountries.map((c) => c.toUpperCase()).join(', ')}, so those
       scored on a smaller sample.</p>`
    : '';

  const failed = report.failedCountries.length
    ? `<p class="note">No data for ${report.failedCountries.map((c) => c.toUpperCase()).join(', ')}.</p>`
    : '';

  return (
    `<h2>${escapeHtml(report.keyword)} across ${report.results.length} storefront(s)</h2>` +
    table({
      head: [
        'Storefront',
        '',
        { label: 'Score', num: true },
        '',
        'Verdict',
        { label: 'Credible rivals', num: true },
      ],
      rows,
    }) +
    verdictLine +
    reduced +
    failed
  );
}
