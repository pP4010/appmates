/** Listing text against both stores' field limits. */

import { validateListing, validateLocales } from '../lib/metadata.js';
import { bar, el, empty, escapeHtml, findingsPanel, pill, tablePanel } from './shared.js';

const INPUTS = {
  title: 'mdTitle',
  subtitle: 'mdSubtitle',
  short_description: 'mdShort',
  promotional_text: 'mdPromo',
  keywords: 'mdKeywords',
  description: 'mdDescription',
};

const PLATFORM_STORAGE_KEY = 'appmates:metadata-platforms';

/**
 * Which store(s) to check against — an app that's iOS-only has no
 * `short_description` to fill in, and Play's required field was showing up
 * as an error for exactly that reason before this existed. Read by
 * views/readiness.js too, so its own combined report agrees with this page
 * rather than always checking both regardless of what's ticked here.
 */
export function getSelectedStores() {
  const stores = [];
  if (el('mdPlatformApple')?.checked) stores.push('apple');
  if (el('mdPlatformGoogle')?.checked) stores.push('google');
  return stores;
}

function restorePlatforms() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(PLATFORM_STORAGE_KEY) ?? 'null');
  } catch {
    /* falls through to the defaults already checked in the HTML */
  }
  if (saved && typeof saved === 'object') {
    if ('apple' in saved) el('mdPlatformApple').checked = Boolean(saved.apple);
    if ('google' in saved) el('mdPlatformGoogle').checked = Boolean(saved.google);
  }
}

function savePlatforms() {
  try {
    localStorage.setItem(
      PLATFORM_STORAGE_KEY,
      JSON.stringify({ apple: el('mdPlatformApple').checked, google: el('mdPlatformGoogle').checked }),
    );
  } catch {
    /* the choice still applies this session; it just won't be remembered */
  }
}

export function initMetadata() {
  restorePlatforms();
  for (const id of Object.values(INPUTS)) el(id).addEventListener('input', render);
  for (const id of ['mdPlatformApple', 'mdPlatformGoogle']) {
    el(id).addEventListener('change', () => {
      savePlatforms();
      render();
      renderLocales();
    });
  }
  el('mdLocalesInput').addEventListener('input', renderLocales);
  render();
  renderLocales();
}

function render() {
  const values = Object.fromEntries(Object.entries(INPUTS).map(([k, id]) => [k, el(id).value]));
  const stores = getSelectedStores();

  if (!stores.length) {
    el('mdSummary').innerHTML = '';
    el('mdFields').innerHTML = empty(
      '¶',
      'No store selected',
      'Check at least one of App Store / Google Play above to see field limits.',
    );
    el('mdFindings').innerHTML = '';
    return;
  }

  if (!Object.values(values).some(Boolean)) {
    el('mdSummary').innerHTML = '';
    el('mdFields').innerHTML = empty(
      '¶',
      'Nothing to check yet',
      stores.length === 2
        ? 'Fill in any field above — both stores are checked as you type.'
        : `Fill in any field above — ${stores[0] === 'apple' ? 'the App Store' : 'Google Play'} is checked as you type.`,
    );
    el('mdFindings').innerHTML = '';
    return;
  }

  const report = validateListing(values, { stores });
  const verdict =
    report.status === 'pass'
      ? 'Within every limit'
      : report.status === 'warn'
        ? 'Within limits, but tight'
        : 'Over a limit';

  el('mdSummary').innerHTML = `
    <div class="summary ${report.status}">
      <span class="verdict">${verdict}</span>
      <span class="muted">${report.errorCount} error(s) · ${report.warningCount} warning(s)</span>
    </div>`;

  const rows = report.fields
    .filter((f) => f.value || f.required)
    .map((f) => {
      const pct = f.maxLength ? (100 * f.length) / f.maxLength : 0;
      const tone = pct > 100 ? 'over' : pct >= 90 ? 'warn' : 'ok';
      return [
        f.store === 'apple' ? 'App Store' : 'Google Play',
        { html: `<strong>${escapeHtml(f.name)}</strong>` },
        { html: bar(pct, tone), tight: true },
        {
          html: `<span class="mono ${tone === 'over' ? 'delta down' : ''}">${f.length}</span><span class="muted mono"> / ${f.maxLength}</span>`,
          num: true,
        },
        { html: f.required ? pill('required', 'info') : '' },
      ];
    });

  el('mdFields').innerHTML = tablePanel({
    title: 'Fields',
    head: ['Store', 'Field', 'Used', { label: 'Characters', num: true }, ''],
    rows,
  });

  el('mdFindings').innerHTML = findingsPanel(report.findings, 'Findings');
}

/**
 * Every locale in one listing, checked at once — the same JSON/TOML shape
 * `validate-metadata` reads on the CLI (`{"locales": [{"locale": "en-US",
 * "title": ..., ...}, ...]}`), so a file written for one works unchanged
 * for the other.
 */
function renderLocales() {
  const raw = el('mdLocalesInput').value.trim();

  if (!raw) {
    el('mdLocalesStatus').innerHTML = '';
    el('mdLocalesResults').innerHTML = empty(
      '¶',
      'No locales pasted yet',
      'Paste a {"locales": [...]} document — the same shape validate-metadata reads on the CLI.',
    );
    return;
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    el('mdLocalesStatus').innerHTML = `<div class="status error">Could not parse JSON: ${escapeHtml(err.message)}</div>`;
    el('mdLocalesResults').innerHTML = '';
    return;
  }

  const entries = Array.isArray(doc) ? doc : doc.locales;
  if (!Array.isArray(entries) || !entries.length) {
    el('mdLocalesStatus').innerHTML =
      '<div class="status error">Expected a "locales" array, or a bare array of locale objects.</div>';
    el('mdLocalesResults').innerHTML = '';
    return;
  }

  const stores = getSelectedStores();
  if (!stores.length) {
    el('mdLocalesStatus').innerHTML =
      '<div class="status error">Check at least one of App Store / Google Play above to see field limits.</div>';
    el('mdLocalesResults').innerHTML = '';
    return;
  }

  el('mdLocalesStatus').innerHTML = '';
  const report = validateLocales(entries, { stores });

  const verdict =
    report.status === 'pass' ? 'Every locale is clean' : report.status === 'warn' ? 'Clean, but tight' : 'Over a limit somewhere';

  const rows = report.locales.map((l) => [
    { html: `<strong>${escapeHtml(l.locale)}</strong>` },
    { html: pill(l.status, l.status === 'pass' ? 'ok' : l.status === 'warn' ? 'warn' : 'bad'), num: true },
    { html: l.errorCount ? String(l.errorCount) : '—', num: true },
    { html: l.warningCount ? String(l.warningCount) : '—', num: true },
  ]);

  el('mdLocalesResults').innerHTML = `
    <div class="summary ${report.status}">
      <span class="verdict">${verdict}</span>
      <span class="muted">${report.locales.length} locale(s) · ${report.errorCount} error(s) · ${report.warningCount} warning(s)</span>
    </div>
    ${tablePanel({
      title: 'Per locale',
      head: ['Locale', { label: 'Status', num: true }, { label: 'Errors', num: true }, { label: 'Warnings', num: true }],
      rows,
    })}
    ${findingsPanel(report.allFindings, 'Findings')}`;
}
