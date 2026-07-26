/** Search position per keyword, tracked in this browser. */

import { checkRank, RankHistory } from '../lib/competitors.js';
import { el, escapeHtml, lines, table, withStatus } from './shared.js';

const history = new RankHistory();

export function initRank(client) {
  el('rankRun').addEventListener('click', () => run(client));
}

async function run(client) {
  const appId = el('rankApp').value.trim();
  const keywords = lines(el('rankKeywords'));
  const results = el('rankResults');

  if (!appId || !keywords.length) {
    results.innerHTML = '<p class="note">Enter an app id and at least one search term.</p>';
    return;
  }

  const country = el('rankCountry').value;
  const report = await withStatus(el('rankStatus'), el('rankRun'), (say) =>
    checkRank(client, appId, keywords, {
      country,
      history,
      onProgress: (keyword, index, total) => say(`${keyword} (${index}/${total})…`),
    }),
  );

  if (!report) return;
  history.append(report);
  results.innerHTML = render(report);
  el('rankClear')?.addEventListener('click', () => {
    history.clear();
    results.innerHTML = '<p class="note">Local history cleared.</p>';
  });
}

function render(report) {
  const rows = report.positions.map((p) => {
    const place =
      p.position !== null
        ? `<strong style="color:${p.position <= 10 ? 'var(--success)' : 'inherit'}">#${p.position}</strong>`
        : `<span style="color:var(--error)">not in top ${p.searchedDepth}</span>`;

    let movement = '<span class="muted">—</span>';
    if (p.movement !== null) {
      if (p.movement > 0) movement = `<span style="color:var(--success)">▲ ${p.movement}</span>`;
      else if (p.movement < 0) movement = `<span style="color:var(--error)">▼ ${Math.abs(p.movement)}</span>`;
      else movement = '<span class="muted">=</span>';
    }

    return [
      escapeHtml(p.keyword),
      { html: place, num: true },
      { html: movement, num: true },
      { html: `<span class="muted">${p.previousDate ?? ''}</span>` },
    ];
  });

  return `
    <h2>
      ${report.artwork ? `<img src="${escapeHtml(report.artwork)}" alt="" width="24" height="24" style="border-radius:6px;vertical-align:-5px;margin-right:.4rem">` : ''}
      ${escapeHtml(report.appName)}
      <span class="muted">· ${escapeHtml(report.country)} · ranked for ${report.rankedFor}/${report.positions.length}</span>
    </h2>
    ${table({
      head: ['Keyword', { label: 'Position', num: true }, { label: 'Movement', num: true }, 'Since'],
      rows,
    })}
    <p class="note">Position in the public catalogue's relevance order, not the App
    Store app's ranking. History is stored in this browser only.
    <button id="rankClear" class="link">Clear history</button></p>`;
}
