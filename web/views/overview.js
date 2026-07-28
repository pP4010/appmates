/**
 * The selected app: what it is, what is left to fix, and where to go next.
 *
 * This view is also the app picker. The chosen app is remembered locally and
 * every other tool reads it, so an id typed once here prefills the rank check,
 * the competitor comparison and the keyword builder — the point of having an
 * app selected at all.
 */

import { checkAppHealth, profileFromEntry } from '../lib/app-profile.js';
import { favorites, onFavoritesChange } from '../lib/favorites.js';
import {
  el, empty, escapeHtml, findingsPanel, pill, ring, tablePanel, withStatus,
} from './shared.js';

const STORAGE_KEY = 'launchpilot:app';

let client = null;
let onChange = null;
/** The app currently rendered, so the star can be kept in sync when a
 * favorite is removed elsewhere (the top-bar tray), not just from here. */
let displayedTrackId = null;

/** The app the whole session is about. Null until one is chosen. */
export function selectedApp() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    return null;
  }
}

function remember(profile, country) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        trackId: profile.trackId,
        bundleId: profile.bundleId,
        name: profile.name,
        seller: profile.seller,
        artwork: profile.artwork,
        country,
      }),
    );
  } catch {
    /* storage disabled; the session still works, it just will not persist */
  }
}

export function forgetApp() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
  onChange?.();
}

export function initOverview(itunesClient, { onAppChange } = {}) {
  client = itunesClient;
  onChange = onAppChange;

  el('ovLoad').addEventListener('click', load);
  el('ovApp').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') load();
  });

  // Keeps the star in sync when a favorite is added or removed from the
  // top-bar tray rather than from this button.
  onFavoritesChange(() => {
    const btn = el('ovFavorite');
    if (btn && displayedTrackId !== null) {
      setStarButton(btn, favorites.has(displayedTrackId));
    }
  });

  const saved = selectedApp();
  if (saved) {
    el('ovApp').value = String(saved.bundleId || saved.trackId);
    el('ovCountry').value = saved.country ?? 'us';
    load();
  } else {
    renderEmpty();
  }
}

function renderEmpty() {
  el('ovResults').innerHTML = empty(
    '◈',
    'No app selected',
    'Enter your App Store id or bundle id. Every other tool will use it from then on.',
  );
}

/** Selects an app and loads it, the same way typing it in and hitting Load
 * would — used by the favorites tray to jump straight to a starred app. */
export function loadApp(appId, country = 'us') {
  el('ovApp').value = appId;
  el('ovCountry').value = country;
  return load();
}

async function load() {
  const appId = el('ovApp').value.trim();
  const country = el('ovCountry').value;
  const results = el('ovResults');

  if (!appId) {
    renderEmpty();
    return;
  }

  let recoveredScreenshots = false;

  const report = await withStatus(el('ovStatus'), el('ovLoad'), results, async (say) => {
    say('Fetching the listing');
    let entry = await client.lookup(appId, { country });
    if (!entry) {
      throw new Error(
        `No app found for "${appId}" in the ${country.toUpperCase()} storefront. ` +
          'Use a numeric App Store id or a bundle id.',
      );
    }

    // Triggered on iPhone specifically, not "both empty": the catalogue often
    // returns iPad shots without iPhone ones (roughly half of apps), and that
    // partial answer must not stop the one device iPhone-first developers
    // actually came here to check from being recovered.
    if (!entry.screenshotUrls?.length) {
      say('Checking the product page for screenshots the catalogue withheld');
      const pageShots = await client.fetchPageScreenshots(entry.trackId, { country });
      if (pageShots?.iphone?.length) {
        entry = {
          ...entry,
          screenshotUrls: pageShots.iphone,
          ipadScreenshotUrls: entry.ipadScreenshotUrls?.length
            ? entry.ipadScreenshotUrls
            : pageShots.ipad,
        };
        recoveredScreenshots = true;
      }
    }

    return checkAppHealth(profileFromEntry(entry));
  });

  if (!report) return;

  remember(report.profile, country);
  onChange?.();
  displayedTrackId = report.profile.trackId;
  results.innerHTML = render(report, recoveredScreenshots);

  el('ovForget')?.addEventListener('click', () => {
    forgetApp();
    el('ovApp').value = '';
    renderEmpty();
  });

  el('ovFavorite')?.addEventListener('click', () => {
    const p = report.profile;
    const nowFavorite = favorites.toggle({
      trackId: p.trackId,
      bundleId: p.bundleId,
      name: p.name,
      seller: p.seller,
      artwork: p.artwork,
      country,
    });
    setStarButton(el('ovFavorite'), nowFavorite);
  });
}

function setStarButton(button, isFavorite) {
  button.classList.toggle('active', isFavorite);
  button.textContent = isFavorite ? '★' : '☆';
  button.setAttribute('aria-pressed', String(isFavorite));
  button.title = isFavorite ? 'Remove from favorites' : 'Add to favorites';
}

function render(report, recoveredScreenshots) {
  return (
    (recoveredScreenshots ? recoveredNote() : '') +
    appHeaderCard(report) +
    screenshots(report.profile) +
    summaryBanner(report) +
    identity(report.profile) +
    checklist(report) +
    nextSteps(report) +
    findingsPanel(report.findings, 'What to fix') +
    limitations()
  );
}

function recoveredNote() {
  return `
    <p class="note">
      Screenshots recovered from the App Store product page — the catalogue did not
      return them. This uses an undocumented Apple structure and may stop working
      without notice.
    </p>`;
}

function appHeaderCard(report) {
  const p = report.profile;

  return `
    <div class="app-header">
      ${p.artwork ? `<img class="app-hero" src="${escapeHtml(p.artwork)}" alt="">` : ''}
      <div class="app-header-body">
        <h2 style="margin:0">
          ${escapeHtml(p.name)}
          <button type="button" id="ovFavorite" class="star-btn ${favorites.has(p.trackId) ? 'active' : ''}"
            aria-pressed="${favorites.has(p.trackId)}"
            title="${favorites.has(p.trackId) ? 'Remove from favorites' : 'Add to favorites'}">${
              favorites.has(p.trackId) ? '★' : '☆'
            }</button>
        </h2>
        <div class="muted">${escapeHtml(p.seller)}</div>
        <div class="app-header-meta">
          ${p.rating ? pill(`${p.rating.toFixed(1)}★ · ${p.ratingCount.toLocaleString('en-US')}`, 'neutral') : ''}
          ${pill(p.formattedPrice || (p.isFree ? 'Free' : `${p.price}`), 'neutral')}
          ${p.primaryGenre ? pill(p.primaryGenre, 'neutral') : ''}
          ${p.version ? pill(`v${p.version}`, 'neutral') : ''}
          ${p.storeUrl ? `<a href="${escapeHtml(p.storeUrl)}" target="_blank" rel="noopener">View on the App Store ↗</a>` : ''}
        </div>
      </div>
      <div class="app-score">
        ${ring(report.score, { size: 66, stroke: 5, thresholds: [80, 50] })}
        <div class="muted" style="font-size:.76rem;text-align:center;margin-top:.3rem">
          ${report.passedCount}/${report.checkedCount} passed${
            report.unknownCount ? `<br>${report.unknownCount} unknown` : ''
          }
        </div>
      </div>
    </div>`;
}

function summaryBanner(report) {
  const tone = report.score >= 80 ? 'ok' : report.score >= 50 ? 'warn' : 'bad';

  return `
    <div class="summary ${tone === 'ok' ? 'pass' : tone === 'warn' ? 'warn' : 'fail'}">
      <span class="verdict">${
        report.score >= 80
          ? 'Listing in good shape'
          : report.score >= 50
            ? 'Listing needs work'
            : 'Listing has real gaps'
      }</span>
      <span class="muted">${report.failing.length} item(s) to address</span>
    </div>`;
}

function identity(p) {
  const runsOn = [
    p.supportsIphone ? 'iPhone' : null,
    p.supportsIpad ? 'iPad' : null,
  ].filter(Boolean).join(' and ') || '—';

  return tablePanel({
    title: 'Listing',
    head: ['Field', { label: 'Value', num: true }],
    rows: [
      ['Bundle id', { html: `<span class="mono">${escapeHtml(p.bundleId ?? '—')}</span>`, num: true }],
      ['App Store id', { html: `<span class="mono">${p.trackId}</span>`, num: true }],
      ['Current version', { html: `${escapeHtml(p.version ?? '—')} · ${p.updatedOn ?? 'unknown'}`, num: true }],
      ['First released', { html: `<span class="mono">${p.releasedOn ?? '—'}</span>`, num: true }],
      ['Category', { html: escapeHtml(p.genres.join(' · ') || '—'), num: true }],
      ['Download size', { html: p.fileSizeBytes ? `${p.sizeMb.toFixed(1)} MB` : '—', num: true }],
      ['Minimum iOS', { html: escapeHtml(p.minimumOs ?? '—'), num: true }],
      ['Age rating', { html: escapeHtml(p.contentRating ?? '—'), num: true }],
      ['Runs on', { html: runsOn, num: true }],
      [
        'Languages',
        {
          html: p.locales.length
            ? `${p.locales.length} — <span class="mono">${escapeHtml(p.locales.join(', '))}</span>`
            : '—',
          num: true,
        },
      ],
      [
        'Description',
        { html: `${p.description.length.toLocaleString('en-US')} characters`, num: true },
      ],
      [
        'Release notes',
        {
          html: p.releaseNotes
            ? `${p.releaseNotes.length} characters`
            : '<span class="muted">none</span>',
          num: true,
        },
      ],
    ],
  });
}

function checklist(report) {
  const rows = report.checks.map((c) => [
    {
      html: c.checkable
        ? c.passed
          ? '<span class="check-mark ok">✓</span>'
          : '<span class="check-mark bad">✕</span>'
        : '<span class="check-mark unknown">?</span>',
      tight: true,
    },
    {
      html: `<strong${c.checkable ? '' : ' class="muted"'}>${escapeHtml(c.label)}</strong><br>
        <span class="muted" style="font-size:.8rem">${escapeHtml(c.detail)}</span>
        ${c.fixHint ? `<br><span style="font-size:.8rem;color:var(--warn)">${escapeHtml(c.fixHint)}</span>` : ''}`,
    },
    {
      html: c.checkable
        ? c.passed
          ? pill('pass', 'ok')
          : pill(c.severity, c.severity === 'error' ? 'bad' : c.severity === 'warning' ? 'warn' : 'info')
        : pill('not knowable', 'neutral'),
      num: true,
    },
  ]);

  return tablePanel({
    title: 'Readiness',
    sub: `${report.passedCount} of ${report.checkedCount} answerable checks passed`,
    head: ['', 'Check', { label: 'Result', num: true }],
    rows,
  });
}

/**
 * Where to go next, prefilled.
 *
 * The checks say what is wrong; these say which tool fixes it. Without them the
 * overview is a report card rather than a starting point.
 */
function nextSteps(report) {
  const p = report.profile;
  const seed = encodeURIComponent(p.primaryGenre?.toLowerCase() ?? p.name.toLowerCase());

  const steps = [
    {
      href: '#rank',
      label: 'Track your position',
      why: 'See where this app sits for the terms you care about, and how it moves.',
    },
    {
      href: '#competitors',
      label: 'Study the field',
      why: 'Who holds your terms, how many screenshots they ship, and what they all target.',
    },
    {
      href: '#keywords',
      label: 'Audit the keyword field',
      why: 'The 100 characters nobody sees — and the only listing field with no feedback loop.',
    },
    {
      href: '#markets',
      label: 'Find an easier storefront',
      why:
        p.locales.length <= 2
          ? `Localised into ${p.locales.length || 'one'} language, so most storefronts are untried.`
          : 'A term locked in one language is routinely open in another.',
    },
    {
      href: '#screenshots',
      label: 'Check your screenshot files',
      why: 'The catalogue only serves downscaled copies; the real files can be checked here.',
    },
  ];

  return `
    <h3>Where to go next</h3>
    <div class="next-grid">
      ${steps
        .map(
          (s) => `
        <a class="next-card" href="${s.href}">
          <strong>${escapeHtml(s.label)}</strong>
          <span class="muted">${escapeHtml(s.why)}</span>
        </a>`,
        )
        .join('')}
    </div>
    <p class="note" style="display:none">${seed}</p>`;
}

function screenshots(p) {
  const shots = p.iphoneScreenshots.length ? p.iphoneScreenshots : p.ipadScreenshots;
  if (!shots.length) return '';

  const which = p.iphoneScreenshots.length ? 'iPhone' : 'iPad';
  const shown = shots.slice(0, 10);
  return `
    <h3>Your ${which} screenshots</h3>
    <p class="note">Served downscaled by the catalogue, so this shows the ratio and the
      order — not the resolution you uploaded.</p>
    <div class="screenshot-wall" style="--shot-count:${shown.length}">
      ${shown.map((u) => `<img src="${escapeHtml(u)}" alt="" loading="lazy">`).join('')}
    </div>`;
}

function limitations() {
  return `
    <div class="callout">
      <strong>What this page cannot see.</strong> Your subtitle and keyword field are not
      public, so neither is checked here. Screenshot URLs serve a downscaled image that
      keeps the aspect ratio but not the resolution, so the device family is inferred and
      the uploaded size is never claimed. The catalogue exposes screenshots for roughly
      half of apps — checks it cannot answer are marked <strong>not knowable</strong> and
      left out of the score rather than counted as failures.
      <br><br>
      <button id="ovForget" class="ghost">Choose a different app</button>
    </div>`;
}
