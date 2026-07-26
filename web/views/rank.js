/** Search position per keyword, tracked in this browser. */

import { checkRank, RankHistory } from '../lib/competitors.js';
import { appIcon, delta, el, empty, escapeHtml, lines, tablePanel, withStatus } from './shared.js';

const history = new RankHistory();

export function initRank(client) {
  el('rankRun').addEventListener('click', () => run(client));
  el('rankResults').innerHTML = empty(
    '↗',
    'Nothing checked yet',
    'Enter your App Store id and the terms you care about.',
  );
}

async function run(client) {
  const appId = el('rankApp').value.trim();
  const keywords = lines(el('rankKeywords'));
  const results = el('rankResults');

  if (!appId || !keywords.length) {
    results.innerHTML = empty('↗', 'Missing input', 'An app id and at least one search term.');
    return;
  }

  const country = el('rankCountry').value;
  const report = await withStatus(el('rankStatus'), el('rankRun'), results, (say) =>
    checkRank(client, appId, keywords, {
      country,
      history,
      onProgress: (keyword, index, total) => say(`${keyword} — ${index} of ${total}`),
    }),
  );

  if (!report) return;
  history.append(report);
  results.innerHTML = render(report);

  el('rankClear')?.addEventListener('click', () => {
    history.clear();
    el('rankResults').innerHTML = empty('↗', 'History cleared', 'Run a check to start again.');
  });
}

function render(report) {
  const rows = report.positions.map((p) => [
    { html: `<strong>${escapeHtml(p.keyword)}</strong>` },
    {
      html:
        p.position !== null
          ? `<strong class="${p.position <= 10 ? 'delta up' : ''}" style="font-size:.95rem">#${p.position}</strong>`
          : `<span class="muted">not in top ${p.searchedDepth}</span>`,
      num: true,
    },
    { html: delta(p.movement), num: true },
    { html: `<span class="muted mono">${p.previousDate ?? '—'}</span>`, num: true },
  ]);

  return (
    tablePanel({
      title: report.appName,
      sub: `${report.country} · ranked for ${report.rankedFor} of ${report.positions.length}`,
      head: ['Keyword', { label: 'Position', num: true }, { label: 'Movement', num: true }, { label: 'Since', num: true }],
      rows,
    }) +
    `<p class="note">Position in the public catalogue's relevance order, not the App Store
     app's ranking. History is stored in this browser only.
     <button id="rankClear" class="ghost">Clear history</button></p>`
  );
}

export { appIcon };
