/**
 * Floating "Get started" checklist — the same shape as a marketplace's own
 * seller-onboarding widget (bottom-left, collapsible, a progress bar, each
 * step clickable straight to where it happens), tinted with this app's own
 * accent instead of copying anyone's colour choice.
 *
 * Four milestones, shown two at a time: getting the app itself ready
 * (loaded, listing passing Prepare's checks) comes before getting it in
 * front of people (signed in, a listing posted) — group 2 only appears
 * once group 1 is done, so the card never asks for more than a couple of
 * things at once. Each step's "done" state is a real signal, not a
 * page-visited flag — `load-app` reads `selectedApp()` directly,
 * `prepare-listing` reads the last readiness report's status,
 * `sign-in`/`get-testers` ask the community API. Hides itself entirely
 * once all four are true; a finished checklist nagging a returning user is
 * worse than no checklist.
 */

import { el, escapeHtml } from './shared.js';

const STORAGE_KEY = 'appmates:onboard-collapsed';

const ICON_DASHBOARD =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg>';
const ICON_MEGAPHONE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 6a13 13 0 0 0 8.4-2.8A1 1 0 0 1 21 4v12a1 1 0 0 1-1.6.8A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"/><path d="M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14"/><path d="M8 6v8"/></svg>';
const ICON_CLIPBOARD_CHECK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/></svg>';
const ICON_LOG_IN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/></svg>';

const STEPS = [
  {
    id: 'load-app',
    group: 1,
    icon: ICON_DASHBOARD,
    title: 'Load your app',
    desc: 'Point AppMates at your App Store id or bundle id — every other tool uses it from there.',
    hash: '#overview',
    focus: 'ovApp',
  },
  {
    id: 'prepare-listing',
    group: 1,
    icon: ICON_CLIPBOARD_CHECK,
    title: 'Get your listing ready',
    desc: 'Fix what Prepare flags before store review does.',
    hash: '#prepare',
    focus: null,
  },
  {
    id: 'sign-in',
    group: 2,
    icon: ICON_LOG_IN,
    title: 'Sign in',
    desc: 'One account for Get testers and Be a tester.',
    hash: '#community',
    focus: null,
  },
  {
    id: 'get-testers',
    group: 2,
    icon: ICON_MEGAPHONE,
    title: 'Get testers for it',
    desc: 'Post a listing on Get testers so other developers can test it.',
    hash: '#community',
    focus: null,
  },
];

let getCurrentApp = () => null;
let getLastReport = () => null;
let client = null;
let hasListing = false;
let signedIn = false;

function isCollapsed() {
  return localStorage.getItem(STORAGE_KEY) === '1';
}

function setCollapsed(value) {
  localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
}

function stepDone(step) {
  if (step.id === 'load-app') return Boolean(getCurrentApp());
  if (step.id === 'prepare-listing') {
    const report = getLastReport();
    return Boolean(report) && report.status !== 'fail';
  }
  if (step.id === 'sign-in') return signedIn;
  if (step.id === 'get-testers') return hasListing;
  return false;
}

/** Re-reads every step's done state and repaints — cheap and synchronous,
 * so every call site (boot, an app selection, a listing just posted) can
 * call it freely without worrying about redundant renders.
 *
 * Only one group's steps render at a time (group 1: get the app itself
 * ready; group 2: get it in front of testers) — 4 milestones is too many
 * to show at once, but 2 at a time reads as a short, doable list rather
 * than a checklist that never ends. The header's `X/4` count still
 * reflects every step, so progress made in a group that's since scrolled
 * off isn't lost from view. */
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

  const activeGroup =
    STEPS.filter((s, i) => s.group === 1 && !doneFlags[i]).length > 0 ? 1 : 2;
  const visible = STEPS.map((step, i) => ({ step, done: doneFlags[i] })).filter(
    ({ step }) => step.group === activeGroup,
  );

  host.innerHTML = `
    <div class="onboard-head" id="onboardHead" role="button" tabindex="0" aria-expanded="${!collapsed}">
      <strong>Get started</strong>
      <span class="onboard-progress-label">${doneCount}/${STEPS.length} done</span>
      <span class="onboard-chevron" aria-hidden="true">▾</span>
    </div>
    <div class="onboard-bar"><div class="onboard-bar-fill" style="width:${pct}%"></div></div>
    <div class="onboard-steps">
      ${visible
        .map(
          ({ step, done }) => `
        <a class="onboard-step${done ? ' done' : ''}" href="${step.hash}" data-step="${step.id}">
          <span class="onboard-step-icon" aria-hidden="true">${done ? '✓' : step.icon}</span>
          <span class="onboard-step-body">
            <span class="onboard-step-title">${escapeHtml(step.title)}</span>
            <span class="onboard-step-desc">${escapeHtml(step.desc)}</span>
          </span>
        </a>`,
        )
        .join('')}
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
    const step = visible[i].step;
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

async function refreshAuthStatus() {
  if (!client?.configured) {
    signedIn = false;
    return;
  }
  try {
    signedIn = Boolean(await client.me());
  } catch {
    // Network/CORS failure reaching the community API — "not signed in
    // confirmed yet" is the honest default, same as refreshListingStatus().
    signedIn = false;
  }
}

export async function initOnboard({ getCurrentApp: getApp, getLastReport: getReport, communityClient } = {}) {
  getCurrentApp = getApp || (() => null);
  getLastReport = getReport || (() => null);
  client = communityClient ?? null;

  refreshOnboard(); // paints immediately with what's known synchronously
  await Promise.all([refreshListingStatus(), refreshAuthStatus()]);
  refreshOnboard(); // repaints once the async checks land
}
