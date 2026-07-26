/** Is this market worth entering? */

import { analyseKeyword } from '../lib/market.js';
import { el, empty, escapeHtml, lines, notesHtml, pill, ring, toneFor, withStatus } from './shared.js';

const VERDICT = {
  open: ['ok', 'a good app can plausibly rank here'],
  contested: ['warn', 'winnable, but it will take sustained effort'],
  locked: ['bad', 'ranking here is a multi-year project'],
};

export function initNiche(client) {
  el('nicheRun').addEventListener('click', () => run(client));
  el('nicheResults').innerHTML = empty(
    '◎',
    'Nothing analysed yet',
    'Enter one or more search terms to see how winnable each market is.',
  );
}

async function run(client) {
  const keywords = lines(el('nicheKeywords'));
  const results = el('nicheResults');

  if (!keywords.length) {
    results.innerHTML = empty('◎', 'No search terms', 'Enter at least one term, one per line.');
    return;
  }

  const country = el('nicheCountry').value;
  const reports = await withStatus(el('nicheStatus'), el('nicheRun'), results, async (say) => {
    const out = [];
    for (const [index, keyword] of keywords.entries()) {
      say(`${keyword} — ${index + 1} of ${keywords.length}`);
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
          `Your connection could not fetch the full ${page.limitRequested}-result page, so ` +
            `this was scored on ${page.limitUsed}. Competitive depth may read lower than the ` +
            'command-line tool reports.',
        ];
      }
      out.push(report);
    }
    return out;
  });

  if (!reports) return;
  reports.sort((a, b) => b.winnability - a.winnability);
  results.innerHTML = reports.map(card).join('');
}

function card(report) {
  const [tone, blurb] = VERDICT[report.verdict];

  const signals = report.signals
    .map(
      (s) => `
      <tr>
        <td class="tight" style="width:52px">${ring(s.score, { size: 30, stroke: 3 })}</td>
        <td><strong>${escapeHtml(s.label)}</strong><br>
            <span class="muted" style="font-size:.8rem">${escapeHtml(s.rationale)}</span></td>
        <td class="num muted" style="white-space:nowrap">${formatObserved(s)}</td>
        <td class="num">${pill(s.band, { favourable: 'ok', neutral: 'info', hostile: 'bad' }[s.band])}</td>
      </tr>`,
    )
    .join('');

  return `
    <div class="panel">
      <div class="panel-head">
        ${ring(report.winnability, { size: 42, stroke: 4, thresholds: [60, 35] })}
        <span>${escapeHtml(report.keyword)}<br>
          <span class="sub">${blurb}</span></span>
        <span style="margin-left:auto">${pill(report.verdict, tone)}</span>
      </div>
      ${signals ? `<div class="table-wrap"><table><tbody>${signals}</tbody></table></div>` : ''}
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

export { toneFor };
