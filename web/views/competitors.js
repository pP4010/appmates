/** Who holds a term, how they present, and the vocabulary they share. */

import { analyseCompetitors } from '../lib/competitors.js';
import { el, escapeHtml, escapeHtml as esc, notesHtml, table, withStatus } from './shared.js';

export function initCompetitors(client) {
  el('compRun').addEventListener('click', () => run(client));
}

async function run(client) {
  const keyword = el('compKeyword').value.trim();
  const results = el('compResults');
  if (!keyword) {
    results.innerHTML = '<p class="note">Enter a search term.</p>';
    return;
  }

  const country = el('compCountry').value;
  const topN = Math.max(3, Math.min(30, Number(el('compTop').value) || 10));
  const yourText = el('compMine').value;

  const report = await withStatus(el('compStatus'), el('compRun'), async (say) => {
    say(`Fetching “${keyword}”…`);
    const page = await client.search(keyword, { country });
    const report = analyseCompetitors(keyword, {
      country,
      resultCount: page.resultCount,
      entries: page.results,
      topN,
      yourText,
    });
    if (page.reduced) {
      report.notes = [
        ...report.notes,
        `Your connection could not fetch the full ${page.limitRequested}-result page, ` +
          `so this reflects the first ${page.limitUsed}.`,
      ];
    }
    return report;
  });

  if (!report) return;
  results.innerHTML =
    renderApps(report) + renderStrategy(report) + renderTerms(report) + notesHtml(report.notes) +
    renderGalleries(report);
}

function renderApps(report) {
  const rows = report.apps.map((app) => [
    { html: String(app.position), num: true },
    {
      html: `<div class="app-row">
        ${app.artwork ? `<img src="${esc(app.artwork)}" alt="" loading="lazy">` : ''}
        <span>${app.storeUrl ? `<a class="rowlink" href="${esc(app.storeUrl)}" target="_blank" rel="noopener">${esc(app.name)}</a>` : esc(app.name)}
        <br><span class="muted" style="font-size:.82em">${esc(app.seller)}</span></span>
      </div>`,
    },
    { html: app.ratingCount.toLocaleString('en-US'), num: true },
    { html: app.rating ? app.rating.toFixed(1) : '—', num: true },
    { html: app.daysSinceUpdate !== null ? `${app.daysSinceUpdate}d` : '—', num: true },
    {
      html: app.screenshotsExposed
        ? `<span class="${app.iphoneCount ? '' : 'muted'}">${app.iphoneCount}</span>`
        : '<span class="muted">n/a</span>',
      num: true,
    },
    {
      html: app.screenshotsExposed
        ? `<span class="${app.ipadCount ? '' : 'muted'}">${app.ipadCount}</span>`
        : '<span class="muted">n/a</span>',
      num: true,
    },
  ]);

  return (
    `<h2>${esc(report.keyword)} · ${esc(report.country)} <span class="muted">· ${report.resultCount} results</span></h2>` +
    table({
      head: [
        { label: '#', num: true },
        'App',
        { label: 'Ratings', num: true },
        { label: 'Stars', num: true },
        { label: 'Updated', num: true },
        { label: 'iPhone', num: true },
        { label: 'iPad', num: true },
      ],
      rows,
    })
  );
}

function renderStrategy(report) {
  const s = report.strategy;
  if (!s?.appsSampled) return '';
  const distribution = Object.entries(s.distribution)
    .map(([count, n]) => `${count}×${n}`)
    .join(' · ');

  return `
    <h3>What this field does with screenshots</h3>
    ${table({
      head: ['Measure', 'Value'],
      rows: [
        ['Median iPhone screenshots', String(s.medianCount)],
        ['Count distribution', distribution || '—'],
        ['Mostly portrait', `${s.portraitApps} of ${s.appsSampled}`],
        ['Ship iPad screenshots', `${s.ipadApps} of ${s.appsSampled}`],
        ['Using all 10 slots', String(s.usesMaxSlots)],
      ],
    })}
    <p class="note">Computed from the ${s.appsSampled} app(s) whose screenshots the
    catalogue exposed (${s.coveragePercent}% of those checked).</p>`;
}

function renderTerms(report) {
  if (!report.terms.length) return '';
  const rows = report.terms.map((t) => [
    esc(t.term),
    { html: t.score.toFixed(0), num: true },
    { html: `${t.appsInName}/${t.appsTotal}`, num: true },
    { html: `${t.appsInDescription}/${t.appsTotal}`, num: true },
    {
      html: t.inYourListing
        ? '<span style="color:var(--success)">yes</span>'
        : '<span class="muted">—</span>',
    },
  ]);

  const missing = report.terms.filter((t) => !t.inYourListing).slice(0, 10);
  const gap = missing.length
    ? `<div class="callout">Not in your listing:
        <strong>${missing.map((t) => esc(t.term)).join(', ')}</strong>
        <br><span class="muted">Paste these into the Keyword field tool as phrases to rank for.</span>
       </div>`
    : '';

  return (
    '<h3>What this field targets</h3>' +
    table({
      head: [
        'Term',
        { label: 'Consensus', num: true },
        { label: 'In app names', num: true },
        { label: 'In descriptions', num: true },
        'Yours',
      ],
      rows,
    }) +
    `<p class="note">App names weigh four times descriptions: a word in a
     30-character name is a decision, the same word in paragraph four may be prose.</p>` +
    gap
  );
}

function renderGalleries(report) {
  const withShots = report.apps.filter((a) => a.screenshots.some((s) => s.device === 'iphone'));
  if (!withShots.length) return '';

  return (
    '<h3>Their screenshots</h3>' +
    '<p class="note">Loaded directly from Apple’s CDN at thumbnail size. Study the ' +
    'conventions — these are other developers’ copyrighted assets.</p>' +
    withShots
      .map(
        (app) => `
        <div style="margin:1rem 0">
          <div class="muted" style="font-size:.85rem;margin-bottom:.3rem">#${app.position} ${esc(app.name)}</div>
          <div class="gallery">
            ${app.screenshots
              .filter((s) => s.device === 'iphone')
              .slice(0, 10)
              .map(
                (s) =>
                  `<img src="${esc(s.atSize(220))}" alt="" loading="lazy" width="110" height="190">`,
              )
              .join('')}
          </div>
        </div>`,
      )
      .join('')
  );
}
