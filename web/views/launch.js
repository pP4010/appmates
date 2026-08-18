/**
 * Prepare / Research / Track — each its own page, own sidebar link, own set
 * of tool tabs inside.
 *
 * Each used to spell out its own tools as separate always-visible sidebar
 * links (five for Prepare alone). Every tool still exists, completely
 * unchanged — none of its own logic moved. This file only switches which
 * tab is visible within a page. Each tool's own `init*()` (initScreenshots,
 * initKeywords, ...) is still called once at boot in app.js exactly as
 * before: they only ever read elements by id, so nesting those ids one
 * level deeper here changes nothing for them.
 *
 * Also owns "Import from App Store Connect" — the paste box on Prepare that
 * fills Listing text, the Keyword field, and Pricing's current-price column
 * from `appmates asc pull`'s output in one action. Nothing here talks to
 * Apple: it only ever reads what was already pasted in, the same trust
 * boundary as any other text typed into this page.
 */

import { setCurrentPrices } from '../lib/pricing.js';
import { el, escapeHtml } from './shared.js';

/**
 * Wires one page's `.tabs` bar to show/hide its tools, remembering the
 * last-picked tab in localStorage so a reload (or coming back later)
 * doesn't reset to the first one.
 */
function initTabBar(sectionId, tabs, storageKey) {
  const section = document.getElementById(sectionId);
  const buttons = [...section.querySelectorAll(':scope > .tabs .tab')];

  const select = (tab) => {
    for (const b of buttons) {
      const active = b.dataset.tab === tab;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    }
    for (const t of tabs) {
      document.getElementById(`view-${t}`)?.classList.toggle('active', t === tab);
    }
    try {
      localStorage.setItem(storageKey, tab);
    } catch {
      /* the tab still switches; it just won't be remembered next visit */
    }
  };

  for (const b of buttons) b.addEventListener('click', () => select(b.dataset.tab));

  let saved = null;
  try {
    saved = localStorage.getItem(storageKey);
  } catch {
    /* falls through to the default below */
  }
  select(tabs.includes(saved) ? saved : tabs[0]);

  return select;
}

export function initPrepare() {
  const select = initTabBar(
    'view-prepare',
    ['asc-connect', 'screenshots', 'keywords', 'metadata', 'readiness', 'pricing'],
    'appmates:prepare-tab',
  );
  initAscImport(select);
}

export function initResearch() {
  initTabBar('view-research', ['niche', 'markets', 'competitors'], 'appmates:research-tab');
}

export function initTrack() {
  initTabBar('view-track', ['rank', 'testers'], 'appmates:track-tab');
}

/* ============================ ASC import ============================ */

function initAscImport(selectPrepareTab) {
  // A starter prompt for whichever coding assistant the developer already
  // has open — not a replacement for the four steps above, a shortcut past
  // them for anyone who'd rather have their own assistant drive it.
  el('ascPromptCopy').addEventListener('click', async (e) => {
    const button = e.currentTarget;
    try {
      await navigator.clipboard.writeText(el('ascPromptText').textContent);
      button.classList.add('copied');
      button.textContent = '✓';
      setTimeout(() => {
        button.classList.remove('copied');
        button.textContent = '⧉';
      }, 1500);
    } catch {
      /* Clipboard access denied (permissions, insecure context) — the
       * prompt is still selectable text, just not one click away. */
    }
  });

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

    // The import is worth seeing land, not just the status line.
    selectPrepareTab('metadata');
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
  select.innerHTML = locales.length
    ? locales
        .map((l, i) => `<option value="${i}">${escapeHtml(l.locale ?? `locale ${i + 1}`)}</option>`)
        .join('')
    : '<option value="" disabled selected>Paste JSON above first</option>';
}
