/**
 * Floating "Get started" checklist — the same shape as a marketplace's own
 * seller-onboarding widget (bottom-left, collapsible, a progress bar, each
 * step clickable straight to where it happens), tinted with this app's own
 * accent instead of copying anyone's colour choice.
 *
 * Two steps, not more: load an app, then get it tested — the actual core
 * loop this whole product exists for. Each step's "done" state is a real
 * signal, not a page-visited flag — `load-app` reads `selectedApp()`
 * directly, `get-testers` asks the community API whether this account has
 * ever posted a listing. Hides itself entirely once both are true; a
 * finished checklist nagging a returning user is worse than no checklist.
 */

import { el, escapeHtml } from './shared.js';

const STORAGE_KEY = 'appmates:onboard-collapsed';

const STEPS = [
  {
    id: 'load-app',
    icon: '◈',
    title: 'Load your app',
    desc: 'Point AppMates at your App Store id or bundle id — every other tool uses it from there.',
    hash: '#overview',
    focus: 'ovApp',
  },
  {
    id: 'get-testers',
    icon: '◍',
    title: 'Get testers for it',
    desc: 'Post a listing on Get testers so other developers can test it.',
    hash: '#community',
    focus: null,
  },
];

let getCurrentApp = () => null;
let client = null;
let hasListing = false;

function isCollapsed() {
  return localStorage.getItem(STORAGE_KEY) === '1';
}

function setCollapsed(value) {
  localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
}

function stepDone(step) {
  if (step.id === 'load-app') return Boolean(getCurrentApp());
  if (step.id === 'get-testers') return hasListing;
  return false;
}

/** Re-reads `getCurrentApp()`/`hasListing` and repaints — cheap and
 * synchronous, so every call site (boot, an app selection, a listing just
 * posted) can call it freely without worrying about redundant renders. */
export function refreshOnboard() {
  const host = el('onboardCard');
  if (!host) return;

  const doneFlags = STEPS.map(stepDone);
  const doneCount = doneFlags.filter(Boolean).length;

  if (doneCount === STEPS.length) {
    host.classList.add('hidden');
    host.innerHTML = '';
    return;
  }

  const collapsed = isCollapsed();
  host.classList.remove('hidden');
  host.classList.toggle('collapsed', collapsed);
  const pct = Math.round((doneCount / STEPS.length) * 100);

  host.innerHTML = `
    <div class="onboard-head" id="onboardHead" role="button" tabindex="0" aria-expanded="${!collapsed}">
      <strong>Get started</strong>
      <span class="onboard-progress-label">${doneCount}/${STEPS.length} done</span>
      <span class="onboard-chevron" aria-hidden="true">▾</span>
    </div>
    <div class="onboard-bar"><div class="onboard-bar-fill" style="width:${pct}%"></div></div>
    <div class="onboard-steps">
      ${STEPS.map(
        (step, i) => `
        <a class="onboard-step${doneFlags[i] ? ' done' : ''}" href="${step.hash}" data-step="${step.id}">
          <span class="onboard-step-icon" aria-hidden="true">${doneFlags[i] ? '✓' : step.icon}</span>
          <span class="onboard-step-body">
            <span class="onboard-step-title">${escapeHtml(step.title)}</span>
            <span class="onboard-step-desc">${escapeHtml(step.desc)}</span>
          </span>
        </a>`,
      ).join('')}
    </div>`;

  const toggle = () => {
    setCollapsed(!isCollapsed());
    refreshOnboard();
  };
  const head = el('onboardHead');
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });

  // Only the destination-input focus needs JS — the navigation itself is a
  // plain `href="#..."`, already wired to the app's own hashchange router.
  host.querySelectorAll('.onboard-step').forEach((a, i) => {
    const step = STEPS[i];
    if (!step.focus) return;
    a.addEventListener('click', () => {
      setTimeout(() => document.getElementById(step.focus)?.focus(), 60);
    });
  });
}

async function refreshListingStatus() {
  if (!client?.configured) {
    hasListing = false;
    return;
  }
  try {
    const listings = await client.myListings();
    hasListing = listings.length > 0;
  } catch {
    // Not signed in, or the community API is unreachable — either way,
    // "no listing confirmed yet" is the honest default, not an error state
    // for a decoration.
    hasListing = false;
  }
}

export async function initOnboard({ getCurrentApp: getApp, communityClient } = {}) {
  getCurrentApp = getApp || (() => null);
  client = communityClient ?? null;

  refreshOnboard(); // paints immediately with what's known synchronously
  await refreshListingStatus();
  refreshOnboard(); // repaints once the listing check lands
}
