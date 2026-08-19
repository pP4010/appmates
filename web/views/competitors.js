/** Who holds a term, how they present, and the vocabulary they share. */

import { analyseCompetitors } from '../lib/competitors.js';
import {
  appIcon, el, empty, escapeHtml, flagEmoji, notesHtml, pill, ring, tablePanel, withStatus,
} from './shared.js';

export function initCompetitors(client) {
  el('compRun').addEventListener('click', () => run(client));
  el('compResults').innerHTML = empty(
    '⧉',
    'No field analysed yet',
    'See who holds a term, how many screenshots they ship, and what they all target.',
  );
}

async function run(client) {
  const keyword = el('compKeyword').value.trim();
  const results = el('compResults');
  if (!keyword) {
    results.innerHTML = empty('⧉', 'No search term', 'Enter a term to see the field.');
    return;
  }

  const country = el('compCountry').value;
  const topN = Math.max(3, Math.min(30, Number(el('compTop').value) || 10));
  const yourText = el('compMine').value;

  const report = await withStatus(el('compStatus'), el('compRun'), results, async (say) => {
    say(`Fetching “${keyword}”`);
    const page = await client.search(keyword, { country });
    const built = analyseCompetitors(keyword, {
      country,
      resultCount: page.resultCount,
      entries: page.results,
      topN,
      yourText,
    });
    if (page.reduced) {
      built.notes = [
        ...built.notes,
        `Your connection could not fetch the full ${page.limitRequested}-result page, so this ` +
          `reflects the first ${page.limitUsed}.`,
      ];
    }
    return built;
  });

  if (!report) return;
  results.innerHTML =
    apps(report) + strategy(report) + terms(report) + notesHtml(report.notes) + galleries(report);
}

function apps(report) {
  const rows = report.apps.map((app) => [
    { html: `<span class="muted mono">${app.position}</span>`, num: true },
    {
      html: `<span class="app-cell">${appIcon(app.artwork, app.name)}
        <span><span class="app-name">${
          app.storeUrl
            ? `<a href="${escapeHtml(app.storeUrl)}" target="_blank" rel="noopener">${escapeHtml(app.name)}</a>`
            : escapeHtml(app.name)
        }</span><br><span class="app-seller">${escapeHtml(app.seller)}</span></span></span>`,
      tight: true,
    },
    { html: app.ratingCount.toLocaleString('en-US'), num: true },
    { html: app.rating ? app.rating.toFixed(1) : '—', num: true },
    { html: app.daysSinceUpdate !== null ? `${app.daysSinceUpdate}d` : '—', num: true },
    { html: screenshotCell(app, 'iphoneCount'), num: true },
    { html: screenshotCell(app, 'ipadCount'), num: true },
  ]);

  return tablePanel({
    title: report.keyword,
    sub: `${flagEmoji(report.country)} ${report.country.toUpperCase()} · ${report.resultCount} results`,
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
  });
}

function screenshotCell(app, key) {
  // "n/a" and "0" mean different things: the catalogue withheld the set, versus
  // the developer shipped none. Collapsing them would invent a fact.
  if (!app.screenshotsExposed) return '<span class="muted">n/a</span>';
  return app[key] ? String(app[key]) : '<span class="muted">0</span>';
}

function strategy(report) {
  const s = report.strategy;
  if (!s?.appsSampled) return '';
  const distribution = Object.entries(s.distribution).map(([n, c]) => `${n}×${c}`).join(' · ');

  return (
    tablePanel({
      title: 'What this field does with screenshots',
      sub: `from ${s.appsSampled} exposed app(s) — ${s.coveragePercent}% of those checked`,
      head: ['Measure', { label: 'Value', num: true }],
      rows: [
        ['Median iPhone screenshots', { html: `<strong>${s.medianCount}</strong>`, num: true }],
        ['Count distribution', { html: `<span class="mono">${distribution || '—'}</span>`, num: true }],
        ['Mostly portrait', { html: `${s.portraitApps} of ${s.appsSampled}`, num: true }],
        ['Ship iPad screenshots', { html: `${s.ipadApps} of ${s.appsSampled}`, num: true }],
        ['Using all 10 slots', { html: String(s.usesMaxSlots), num: true }],
      ],
    })
  );
}

function terms(report) {
  if (!report.terms.length) return '';

  const rows = report.terms.map((t) => [
    { html: `<strong>${escapeHtml(t.term)}</strong>` },
    { html: ring(t.score, { size: 30, stroke: 3, thresholds: [50, 20] }), tight: true, center: true },
    { html: `${t.appsInName}/${t.appsTotal}`, num: true },
    { html: `${t.appsInDescription}/${t.appsTotal}`, num: true },
    { html: t.inYourListing ? pill('yours', 'ok') : pill('missing', 'neutral') },
  ]);

  const missing = report.terms.filter((t) => !t.inYourListing).slice(0, 10);
  const gap = missing.length
    ? `<div class="callout">Not in your listing:
        <strong>${missing.map((t) => escapeHtml(t.term)).join(', ')}</strong><br>
        Paste these into <a href="#keywords">Keyword field</a> as phrases to rank for.</div>`
    : '';

  return (
    tablePanel({
      title: 'What this field targets',
      sub: 'app names weigh four times descriptions',
      head: [
        'Term',
        { label: 'Consensus', center: true },
        { label: 'In names', num: true },
        { label: 'In descriptions', num: true },
        'Yours',
      ],
      rows,
    }) + gap
  );
}

function galleries(report) {
  const withShots = report.apps.filter((a) => a.screenshots.some((s) => s.device === 'iphone'));
  if (!withShots.length) return '';

  return (
    '<h3>Their screenshots</h3>' +
    '<p class="note">Loaded straight from Apple’s CDN at thumbnail size. Study the ' +
    'conventions — these are other developers’ copyrighted assets.</p>' +
    withShots
      .map(
        (app) => `
        <div class="gallery-group">
          <div class="gallery-title">#${app.position} ${escapeHtml(app.name)}</div>
          <div class="gallery">
            ${app.screenshots
              .filter((s) => s.device === 'iphone')
              .slice(0, 10)
              .map((s) => `<img src="${escapeHtml(s.atSize(220))}" alt="" loading="lazy">`)
              .join('')}
          </div>
        </div>`,
      )
      .join('')
  );
}
