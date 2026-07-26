/** Is this market worth entering? */

import { analyseKeyword } from '../lib/market.js';
import { el, escapeHtml, lines, meter, notesHtml, withStatus } from './shared.js';

export function initNiche(client) {
  el('nicheRun').addEventListener('click', () => run(client));
}

async function run(client) {
  const keywords = lines(el('nicheKeywords'));
  const country = el('nicheCountry').value;
  const results = el('nicheResults');

  if (!keywords.length) {
    results.innerHTML = '<p class="note">Enter at least one search term.</p>';
    return;
  }

  const reports = await withStatus(el('nicheStatus'), el('nicheRun'), async (say) => {
    const out = [];
    for (const [index, keyword] of keywords.entries()) {
      say(`${keyword} (${index + 1}/${keywords.length})…`);
      const page = await client.search(keyword, { country });
      const report = analyseKeyword(keyword, {
        country,
        resultCount: page.resultCount,
        entries: page.results,
      });
      if (page.reduced) {
        // Say so rather than letting a truncated page read as a thin market.
        report.notes = [
          ...report.notes,
          `Your connection could not fetch the full ${page.limitRequested}-result page, ` +
            `so this was scored on ${page.limitUsed}. Competitive depth may read lower ` +
            'than the command-line tool reports.',
        ];
      }
      out.push(report);
    }
    return out;
  });

  if (!reports) return;
  reports.sort((a, b) => b.winnability - a.winnability);
  results.innerHTML = reports.map(renderReport).join('');
}

function renderReport(report) {
  const blurb = {
    open: 'a good app can plausibly rank here',
    contested: 'winnable, but it will take sustained effort',
    locked: 'ranking here is a multi-year project',
  }[report.verdict];

  const signals = report.signals
    .map(
      (s) => `
      <div class="finding">
        <span class="signal-band ${s.band}">${s.score.toFixed(0)}</span>
        <span class="msg"> <strong>${escapeHtml(s.label)}</strong>
          <span class="mono muted">${formatObserved(s)}</span></span>
        <div class="hint">${escapeHtml(s.rationale)}</div>
      </div>`,
    )
    .join('');

  return `
    <div class="card">
      <div class="card-head">
        <span class="badge ${report.verdict}">${report.verdict}</span>
        <span class="name">${escapeHtml(report.keyword)}</span>
        <span class="meta">${report.winnability.toFixed(0)}/100 — ${blurb}</span>
        <span class="meta mono">${meter(report.winnability, { width: 14, thresholds: [60, 35] })}</span>
      </div>
      ${signals ? `<div class="findings">${signals}</div>` : ''}
    </div>
    ${notesHtml(report.notes)}`;
}

function formatObserved(signal) {
  const value =
    signal.unit === 'stars' || signal.unit === 'percent'
      ? signal.observed.toFixed(1)
      : Math.round(signal.observed).toLocaleString('en-US');
  return `${value} ${signal.unit}`;
}
