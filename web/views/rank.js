/** Search position per keyword, tracked in this browser. */

import { checkRank, RankHistory } from '../lib/competitors.js';
import { favorites, onFavoritesChange } from '../lib/favorites.js';
import { appIcon, delta, el, empty, escapeHtml, lines, tablePanel, withStatus } from './shared.js';

const history = new RankHistory();
const LAST_INPUT_KEY = 'appmates:rank-last-input';

export function initRank(client) {
  el('rankRun').addEventListener('click', () => run(client));
  el('rankResults').innerHTML = empty(
    '↗',
    'Nothing checked yet',
    'Enter your App Store id and the terms you care about.',
  );

  renderFavPicks();
  onFavoritesChange(renderFavPicks);
  el('rankFavPicks').addEventListener('click', (e) => {
    const pick = e.target.closest('.fav-pick');
    if (!pick) return;
    el('rankApp').value = pick.dataset.trackId;
    if (pick.dataset.country) el('rankCountry').value = pick.dataset.country;
    updateRunButton();
    renderFavPicks();
  });

  for (const id of ['rankApp', 'rankKeywords']) {
    el(id).addEventListener('input', updateRunButton);
  }
  updateRunButton();

  // Picking up where the last visit left off: same app, same terms, run
  // again immediately so movement since last time shows without the user
  // having to re-type anything or remember to click Check.
  const last = loadLastInput();
  if (last) {
    el('rankApp').value = last.appId;
    el('rankKeywords').value = last.keywords;
    if (last.country) el('rankCountry').value = last.country;
    updateRunButton();
    renderFavPicks();
    run(client);
  }
}

function updateRunButton() {
  const ready = Boolean(el('rankApp').value.trim()) && lines(el('rankKeywords')).length > 0;
  el('rankRun').disabled = !ready;
}

function renderFavPicks() {
  const list = favorites.list();
  const row = el('rankFavPicks');
  row.classList.toggle('hidden', list.length === 0);
  if (!list.length) return;

  const current = el('rankApp').value.trim();
  row.innerHTML = list
    .map(
      (a) => `
      <button type="button" class="fav-pick ${String(a.trackId) === current ? 'active' : ''}"
        data-track-id="${escapeHtml(a.trackId)}" data-country="${escapeHtml(a.country ?? 'us')}"
        title="${escapeHtml(a.name)}">${appIcon(a.artwork, a.name)}</button>`,
    )
    .join('');
}

function loadLastInput() {
  try {
    const raw = localStorage.getItem(LAST_INPUT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.appId && parsed?.keywords ? parsed : null;
  } catch {
    return null;
  }
}

function saveLastInput(appId, keywords, country) {
  try {
    localStorage.setItem(LAST_INPUT_KEY, JSON.stringify({ appId, keywords, country }));
  } catch {
    /* the check still runs this session; it just won't resume next time */
  }
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
  saveLastInput(appId, el('rankKeywords').value, country);

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
  renderFavPicks();

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
