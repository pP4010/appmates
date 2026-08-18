/**
 * "Ready for launch" — Prepare, Research and Track, together on one page.
 *
 * Used to be three always-visible sidebar sections spelling out ten tools by
 * name; that made the sidebar the least scannable part of the app. Every
 * tool still exists, unchanged — this file only switches which one is
 * visible. Each tool's own `init*()` (initScreenshots, initKeywords, ...)
 * is still called once at boot in app.js exactly as before: they only ever
 * read elements by id, so nesting those ids one level deeper here changes
 * nothing for them.
 *
 * Also owns "Import from App Store Connect" — the paste box that fills
 * Listing text, the Keyword field, and Pricing's current-price column from
 * `appmates asc pull`'s output in one action. Nothing here talks to Apple:
 * it only ever reads what was already pasted in, the same trust boundary as
 * any other text typed into this page.
 */

import { setCurrentPrices } from '../lib/pricing.js';
import { el, escapeHtml } from './shared.js';

/** Which tool belongs to which top-level group, and the order sub-tabs
 * render in — the single source of truth `selectGroup` and the HTML's own
 * `data-tab` attributes both have to agree with. */
const GROUPS = {
  prepare: ['screenshots', 'keywords', 'metadata', 'readiness', 'pricing'],
  research: ['niche', 'markets', 'competitors'],
  track: ['rank', 'testers'],
};

const STORAGE_KEY = 'appmates:launch-tab';

export function initLaunch() {
  document.querySelectorAll('#launchGroupTabs .tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const group = btn.dataset.group;
      selectGroup(group);
      // Switching group alone picks no tool to show — go to whichever
      // sub-tab is already marked active within that group's own bar (it
      // stays marked even while hidden), defaulting to the first.
      const current =
        document.querySelector(`.launch-subtabs[data-group="${group}"] .tab.active`)?.dataset.tab ??
        GROUPS[group][0];
      selectTab(group, current);
      remember(group, current);
    });
  });
  document.querySelectorAll('.launch-subtabs .tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const group = btn.closest('.launch-subtabs').dataset.group;
      selectTab(group, btn.dataset.tab);
      remember(group, btn.dataset.tab);
    });
  });

  const saved = restoreSaved();
  selectGroup(saved.group);
  selectTab(saved.group, saved.tab);

  initAscImport();
}

function restoreSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (saved?.group in GROUPS && GROUPS[saved.group].includes(saved.tab)) return saved;
  } catch {
    /* fall through to the default below */
  }
  return { group: 'prepare', tab: 'screenshots' };
}

function remember(group, tab) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ group, tab }));
  } catch {
    /* the tab still switches; it just won't be remembered next visit */
  }
}

function selectGroup(group) {
  document
    .querySelectorAll('#launchGroupTabs .tab')
    .forEach((b) => setActive(b, b.dataset.group === group));
  document
    .querySelectorAll('.launch-subtabs')
    .forEach((el) => el.classList.toggle('active', el.dataset.group === group));
}

function selectTab(group, tab) {
  document
    .querySelectorAll(`.launch-subtabs[data-group="${group}"] .tab`)
    .forEach((b) => setActive(b, b.dataset.tab === tab));
  // Tab ids are unique across every group, so activating the chosen one and
  // deactivating every other tool's panel is enough regardless of which
  // group each belongs to.
  for (const t of Object.values(GROUPS).flat()) {
    document.getElementById(`view-${t}`)?.classList.toggle('active', t === tab);
  }
}

function setActive(button, active) {
  button.classList.toggle('active', active);
  button.setAttribute('aria-selected', String(active));
}

/* ============================ ASC import ============================ */

function initAscImport() {
  el('lnAscInput').addEventListener('input', () => {
    const doc = parseAscPaste(el('lnAscInput').value);
    populateAscLocaleSelect(doc?.locales ?? []);
  });

  el('lnAscImport').addEventListener('click', () => {
    const doc = parseAscPaste(el('lnAscInput').value);
    if (doc === null) {
      el('lnAscStatus').innerHTML = '<div class="status error">Could not parse JSON.</div>';
      return;
    }
    const locales = Array.isArray(doc.locales) ? doc.locales : [];
    if (!locales.length) {
      el('lnAscStatus').innerHTML =
        '<div class="status error">No "locales" array found in the pasted JSON.</div>';
      return;
    }
    const index = Number(el('lnAscLocale').value || 0);
    const locale = locales[index] ?? locales[0];

    const setField = (id, value) => {
      if (value === undefined || value === null) return;
      const field = el(id);
      if (!field) return;
      field.value = value;
      field.dispatchEvent(new Event('input'));
    };

    // Metadata and Keywords each listen for `input` on their own fields
    // already (see views/metadata.js, views/keywords.js) — Readiness
    // listens on the same ones too, so importing here updates all three
    // live, the same "select once, prefill everywhere" idea app.js's own
    // refreshAppCard uses for the app name.
    setField('mdTitle', locale.title);
    setField('mdSubtitle', locale.subtitle);
    setField('mdPromo', locale.promotional_text);
    setField('mdKeywords', locale.keywords);
    setField('mdDescription', locale.description);
    setField('kwTitle', locale.title);
    setField('kwSubtitle', locale.subtitle);
    setField('kwField', locale.keywords);

    let priceNote = '';
    if (Array.isArray(doc.current_prices) && doc.current_prices.length) {
      setCurrentPrices(doc.current_prices);
      window.dispatchEvent(new CustomEvent('appmates:asc-prices'));
      priceNote = ` and ${doc.current_prices.length} current price(s) into Pricing`;
    }

    const liveNote = doc.is_live
      ? ' This is the live, published listing — pushing edits needs a new version created in App Store Connect first.'
      : '';

    el('lnAscStatus').innerHTML = `<div class="status">Imported locale "${escapeHtml(
      locale.locale ?? '',
    )}" into Listing text and the Keyword field${priceNote}.${liveNote}</div>`;

    // The import is worth seeing land, not just the status line: jump to
    // the tab it just filled.
    selectGroup('prepare');
    selectTab('prepare', 'metadata');
    remember('prepare', 'metadata');
  });
}

function parseAscPaste(raw) {
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function populateAscLocaleSelect(locales) {
  const select = el('lnAscLocale');
  select.innerHTML = locales
    .map((l, i) => `<option value="${i}">${escapeHtml(l.locale ?? `locale ${i + 1}`)}</option>`)
    .join('');
}
