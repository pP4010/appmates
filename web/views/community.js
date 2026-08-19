/**
 * Get testers for your own app — the owner half of the Community feature.
 * Browsing for apps to test yourself, requesting to join, and the
 * leaderboard all moved to "Be a tester" (views/be-tester.js): different
 * job, different moment, even though it's the same account and the same
 * reciprocal exchange underneath (see that file's header for the full
 * picture). What's left here is entirely about your own listing: post it,
 * review requests, mark completed tests, and your public profile.
 *
 * Every headline number on a listing card is *recomputed here* from the
 * public catalogue when you look at it — the same engines the rest of this
 * app runs on (`lib/app-profile.js`) — never a figure the person who posted
 * the listing typed in. That is what makes a card worth trusting, and it is
 * why the tools half of this app and the community half are one product
 * rather than two sharing a sidebar.
 *
 * See `community/README.md` for the design rationale — in particular why
 * none of this ever touches App Store/Play reviews or ratings.
 */

import {
  el, escapeHtml, empty, withStatus, appIcon, iconOrInitial, ring, MESSAGEABLE_STATUSES,
  reliabilityBadge, contributionBadge,
} from './shared.js';
import { checkAppHealth, profileFromEntry } from '../lib/app-profile.js';

// Mirrors MAX_BIO_LENGTH in community/src/lib/config.js — the server is the
// real limit (it truncates), this just keeps the on-page counter honest.
const MAX_BIO_LENGTH = 180;

// Get testers only ever shows these two — "My profile" moved out to its own
// standalone route (`#profile`, the sidebar's "Profile" link) so the two
// pages stop being the same content under two names. `showProfileTab`/
// `showCommunityTabs` below switch `viewMode` between them; neither ever
// puts 'profile' back in this tab bar.
const TABS = {
  how: 'How it works',
  mine: 'My dashboard',
};

let client = null;
let itunes = null;
let getCurrentApp = null;
let user = null;
let activeTab = 'mine';
/** 'community' renders the tab bar above (How it works / My dashboard);
 * 'profile' renders just the profile panel, no tabs — see `renderShell`. */
let viewMode = 'community';

export function initCommunity(communityClient, { getCurrentApp: getApp, itunes: itunesClient } = {}) {
  client = communityClient;
  getCurrentApp = getApp || (() => null);
  itunes = itunesClient ?? null;

  const navItem = document.querySelector('.nav-item[href="#community"]');

  if (!client.configured) {
    navItem?.classList.add('hidden');
    el('commBody').innerHTML = empty(
      '◍',
      'Not set up yet',
      'This deployment has no community backend configured. See community/README.md.',
    );
    return;
  }

  refreshSession();
}

async function refreshSession() {
  try {
    user = await client.me();
    renderAll();
  } catch (err) {
    el('commBody').innerHTML = `<div class="status error">${escapeHtml(err.message)}</div>`;
  }
}

function renderAll() {
  renderAuthBar();
  renderShell();
}

/* ============================ auth bar ============================ */

function renderAuthBar() {
  const authBar = el('commAuthBar');
  if (user) {
    authBar.innerHTML = `
      <div class="summary pass" style="margin-bottom:1.2rem">
        <span class="verdict">Signed in as ${escapeHtml(user.email)}</span>
        <span class="muted">${user.tokenBalance} High Five${user.tokenBalance === 1 ? '' : 's'}</span>
        <button id="commLogout" class="ghost" style="margin-left:auto">Sign out</button>
      </div>`;
    el('commLogout').addEventListener('click', async () => {
      await client.logout();
      user = null;
      renderAll();
    });
    return;
  }

  authBar.innerHTML = `
    <div class="toolbar" style="margin-bottom:1.2rem">
      <div class="field" style="flex:1;min-width:14rem">
        <label for="commEmail">Already have an account?</label>
        <input id="commEmail" type="email" placeholder="you@example.com">
      </div>
      <button id="commSendLink">Send sign-in link</button>
    </div>
    <div id="commAuthStatus" class="status"></div>`;
  el('commSendLink').addEventListener('click', sendLink);
  el('commEmail').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendLink();
  });
}

async function sendLink() {
  const email = el('commEmail').value.trim();
  if (!email) return;

  await withStatus(el('commAuthStatus'), el('commSendLink'), null, async (say) => {
    say('Sending link');
    await client.requestLink(email);
    el('commAuthStatus').className = 'status';
    el('commAuthStatus').innerHTML =
      `<span class="muted">Check <strong>${escapeHtml(email)}</strong> for a sign-in link. ` +
      'It expires in 15 minutes.</span>';
  });
}

/* ============================ tabs ============================ */

function renderShell() {
  if (viewMode === 'profile') {
    // No tab bar at all — this page is the profile, not a tab inside a
    // bigger view. See renderProfileTab's own `!user` guard for what shows
    // before sign-in.
    el('commBody').innerHTML = '<div id="commTabPanel" role="tabpanel"></div>';
    renderProfileTab();
    return;
  }

  el('commBody').innerHTML = `
    <div class="tabs" role="tablist">
      ${Object.entries(TABS)
        .map(
          ([key, label]) => `
        <button class="tab ${key === activeTab ? 'active' : ''}" role="tab"
          aria-selected="${key === activeTab}" data-tab="${key}">${escapeHtml(label)}</button>`,
        )
        .join('')}
    </div>
    <div id="commTabPanel" role="tabpanel"></div>`;

  el('commBody')
    .querySelectorAll('.tab')
    .forEach((btn) =>
      btn.addEventListener('click', () => {
        if (btn.dataset.tab === activeTab) return;
        activeTab = btn.dataset.tab;
        renderShell();
      }),
    );

  renderActiveTab();
}

function renderActiveTab() {
  if (activeTab === 'how') renderHowItWorksTab();
  else renderMyDashboardTab();
}

/** The Get-testers-only framing above `commBody` (`#commIntro`,
 * `#commGuardrail` in app.html) — static markup, not part of `renderShell`,
 * so it needs its own toggle rather than being naturally skipped when
 * `renderShell` renders the profile panel instead. Runs unconditionally
 * (unlike the tab content below, which needs a configured backend) since
 * hiding two static paragraphs never depended on the community API. */
function applyViewModeIntro() {
  const isProfile = viewMode === 'profile';
  el('commIntro')?.classList.toggle('hidden', isProfile);
  el('commGuardrail')?.classList.toggle('hidden', isProfile);
}

/** Switches to the standalone profile panel and re-renders — the "Profile"
 * sidebar shortcut (app.js's `#profile` route) calls this rather than
 * duplicating this view's markup under a second id. A no-op before
 * `initCommunity` has run or on a deployment with no community backend
 * (`renderShell` was never called, so there's no `#commBody` shell to
 * replace) — the "not set up yet" message already on screen in that case
 * says so already. */
export function showProfileTab() {
  viewMode = 'profile';
  applyViewModeIntro();
  if (client?.configured) renderShell();
}

/** Switches back to the How it works / My dashboard tabs — app.js's route()
 * calls this on every real `#community` navigation (not the `#profile`
 * shortcut) so leaving Profile for Get testers doesn't leave the profile
 * panel showing under the wrong title. Resets to My dashboard rather than
 * keeping whatever tab was active before Profile was opened, since a tab
 * selection from a previous visit reads as stale, not as state worth
 * preserving. A no-op if Get testers is already showing — avoids a
 * pointless re-render (and the tab-open animation restarting) on every
 * click of a nav link the user was already on. */
export function showCommunityTabs() {
  if (viewMode === 'community') return;
  viewMode = 'community';
  activeTab = 'mine';
  applyViewModeIntro();
  if (client?.configured) renderShell();
}

/* ============================ how it works tab ============================ */

function renderHowItWorksTab() {
  el('commTabPanel').innerHTML = `
    <div class="lead" style="margin-bottom:1.2rem">
      One reciprocal exchange, metered in High Fives so it can't be gamed: posting a
      listing and requesting to test one are both free — the only thing a High Five
      ever buys is prominence, and the only way to earn one is for another developer
      to confirm your testing actually helped.
    </div>

    <h3 style="margin-top:0">Getting your own app tested</h3>
    <ol style="margin:0 0 1.2rem;padding-left:1.3rem;line-height:1.85">
      <li><strong>Post a listing</strong> on My dashboard, free — testing (not out yet) or
        a launch/update (already out). It reuses the app you loaded on Overview: name,
        icon and store link, not retyped.</li>
      <li><strong>Testers request to join</strong> from Be a tester's marketplace — no
        account needed to browse, one is needed to request, and it costs them nothing.
        You review each request and accept or decline.</li>
      <li><strong>Accepted testers check in daily</strong> with a screenshot of the app
        open while they test — a real streak you can see building, not a checkbox that
        could mean "tested once and forgot."</li>
      <li><strong>They submit written feedback</strong>, then <strong>you mark the
        session completed</strong>. That confirmation is what mints their High Five —
        never automatic, never self-awarded by the tester.</li>
    </ol>

    <h3>Testing someone else's app</h3>
    <ol style="margin:0 0 1.2rem;padding-left:1.3rem;line-height:1.85">
      <li>Browse listings on <a href="#be-tester">Be a tester</a> and request to join
        one — a short message on why you're a good fit, same as above.</li>
      <li>Once accepted, test the build and check in daily until you submit feedback.</li>
      <li>When the owner marks it completed, <strong>you earn 1 High Five</strong>.</li>
    </ol>

    <h3>What a High Five actually buys</h3>
    <p class="lead" style="margin-bottom:.5rem">
      Never a review, never a spot you couldn't get for free — only visibility, two ways:
    </p>
    <ul style="margin:0 0 1.2rem;padding-left:1.3rem;line-height:1.85">
      <li><strong>Spend</strong> 3 High Fives/day to feature a listing at the top of the
        marketplace (My dashboard → a listing's "Feature" button) — a highlight sweep
        for as many days as you pay for.</li>
      <li><strong>Hold</strong> a growing balance and every listing you post picks up a
        warmer border on its own — bronze, then silver, then gold — on Be a tester's
        marketplace and the landing page's "Needs testers now". Nothing to spend or
        click: it just reflects what's in your account. <strong>Your very first-ever
        listing gets the bronze tint for free</strong>, at 0 High Fives, so a brand-new
        account isn't the one flat card on the page while it's also the one most in
        need of eyes.</li>
    </ul>
    <p class="note">
      Neither of these ever changes sort order — a 0-High-Five listing still ranks first
      under "Newest" if it was posted most recently. High Fives buy how a card looks,
      never where it lands.
    </p>

    <h3>What this deliberately isn't</h3>
    <p class="lead">
      Nobody here trades App Store or Play reviews, and nothing on this page ever asks a
      tester to leave one. Feedback stays private, between the two of you — if a launch
      listing earns you real users afterward, whether they review is entirely between them
      and the store, same as any other user.
    </p>
  `;
}

/* ============================ my dashboard tab ============================ */

function renderMyDashboardTab() {
  if (!user) {
    el('commTabPanel').innerHTML = empty(
      '◍',
      'Sign in to post a listing',
      'Use the box above. Looking to test someone else\'s app instead? That\'s on Be a tester — no account needed there.',
    );
    return;
  }

  el('commTabPanel').innerHTML = `
    <div id="commDashboardStats"></div>
    <div id="commAsoBridge"></div>

    <h3>Get testers or announce a launch</h3>
    <div id="commCreatePanel"></div>

    <h3>Your listings</h3>
    <div id="commMyListings"></div>`;

  renderDashboardStats();
  renderAsoBridge();
  renderCreatePanel();
  renderMyListings();
}

/** Two cheap numbers up top — the difference between a page that manages a
 * list and one that reads as a dashboard. Deliberately not "pending
 * requests": that count is already visible inline under each listing below,
 * and computing it here would mean one extra fetch per listing. Testing
 * activity has its own numbers on the Be a tester page now — this is the
 * owner side only. */
async function renderDashboardStats() {
  const host = el('commDashboardStats');
  if (!host) return;
  try {
    const listings = await client.myListings();
    const activeListings = listings.filter((l) => l.status === 'open').length;

    host.innerHTML = `
      <div class="dashboard-stats">
        <div class="dashboard-stat">
          <span class="metric-label">High Fives</span>
          <span class="dashboard-stat-value">${user.tokenBalance}</span>
        </div>
        <div class="dashboard-stat">
          <span class="metric-label">Active listings</span>
          <span class="dashboard-stat-value">${activeListings}</span>
        </div>
      </div>`;
  } catch {
    host.innerHTML = '';
  }
}

/**
 * The bridge between the two halves of the product: the same listing-health
 * engine Overview runs (`lib/app-profile.js`), reused here so a builder sees
 * exactly what a tester would find suspect *before* they post a listing —
 * not a separate scoring system, the same one, just surfaced where the
 * decision to finalize is actually being made. Shown whenever an app is
 * connected, whether or not it has a listing yet.
 */
async function renderAsoBridge() {
  const host = el('commAsoBridge');
  if (!host) return;
  const app = getCurrentApp();
  if (!app || !itunes) {
    host.innerHTML = '';
    return;
  }

  host.innerHTML = '<div class="status"><span class="spinner"></span> Checking your listing</div>';
  try {
    const entry = await itunes.lookup(String(app.trackId), { country: app.country || 'us' });
    if (!entry) {
      host.innerHTML = '';
      return;
    }

    const report = checkAppHealth(profileFromEntry(entry));
    const topIssues = report.failing.slice(0, 3);

    host.innerHTML = `
      <div class="panel aso-bridge">
        <div class="aso-bridge-head">
          ${appIcon(app.artwork, app.name)}
          <div style="flex:1;min-width:0">
            <strong>Finalize ${escapeHtml(app.name)}'s launch</strong>
            <div class="muted" style="font-size:.82rem">
              The same listing health Overview computes — fix it there, testers see it here.
            </div>
          </div>
          ${ring(report.score, { size: 52, stroke: 4, thresholds: [80, 50] })}
        </div>
        ${
          topIssues.length
            ? `<ul class="aso-bridge-issues">
                 ${topIssues.map((c) => `<li>${escapeHtml(c.label)}</li>`).join('')}
               </ul>
               <a class="ghost-link" href="#overview">Open Overview to fix →</a>`
            : '<p class="muted" style="font-size:.85rem;margin:.6rem 0 0">Nothing failing — your listing is ready to post.</p>'
        }
      </div>`;
  } catch {
    host.innerHTML = '';
  }
}

function renderCreatePanel() {
  const app = getCurrentApp();
  if (!app) {
    el('commCreatePanel').innerHTML =
      '<p class="note">Load an app on the Overview page first — a listing reuses its name, ' +
      'icon and store link rather than asking you to retype them.</p>';
    return;
  }

  el('commCreatePanel').innerHTML = `
    <div class="app-header" style="margin-bottom:.8rem">
      ${appIcon(app.artwork, app.name)}
      <div class="app-header-body">
        <strong>${escapeHtml(app.name)}</strong>
        <div class="muted">${escapeHtml(app.seller || '')}</div>
      </div>
    </div>
    <div class="form-grid">
      <label for="commKind">This listing is</label>
      <select id="commKind">
        <option value="testing">Looking for closed testers (not out yet)</option>
        <option value="launch">A launch or update (already out)</option>
      </select>
      <label for="commPlatform">Platform</label>
      <select id="commPlatform">
        <option value="ios">iOS</option>
        <option value="android">Android</option>
        <option value="both">Both</option>
      </select>
      <label for="commLink">Link</label>
      <input id="commLink" type="text"
        placeholder="TestFlight/Play testing link, or the store listing once it's out">
      <label for="commSlots">Testers wanted</label>
      <input id="commSlots" type="number" min="0" max="100" value="10" style="width:6rem">
      <label for="commDescription">What should they know</label>
      <textarea id="commDescription" rows="3"
        placeholder="What to focus feedback on, or what's new in this release"></textarea>
    </div>
    <div id="commCreateStatus" class="status"></div>
    <button id="commCreateSubmit" class="primary">Post listing</button>`;

  el('commCreateSubmit').addEventListener('click', () => createListing(app));
}

async function createListing(app) {
  await withStatus(el('commCreateStatus'), el('commCreateSubmit'), null, async (say) => {
    say('Connecting your app');
    const { app: connected } = await client.connectApp({
      trackId: app.trackId,
      bundleId: app.bundleId,
      name: app.name,
      artworkUrl: app.artwork,
      storeUrl: app.storeUrl,
      country: app.country,
    });

    say('Posting listing');
    await client.createListing({
      appId: connected.id,
      kind: el('commKind').value,
      platform: el('commPlatform').value,
      link: el('commLink').value.trim(),
      description: el('commDescription').value.trim(),
      slotsWanted: Number(el('commSlots').value) || 0,
    });

    el('commLink').value = '';
    el('commDescription').value = '';
    await renderMyListings();
  });
}

async function renderMyListings() {
  const container = el('commMyListings');
  if (!container) return;
  container.innerHTML = '<div class="status"><span class="spinner"></span> Loading</div>';
  try {
    const listings = await client.myListings();
    if (!listings.length) {
      container.innerHTML = empty('◍', 'No listings yet', 'Post one above.');
      return;
    }
    container.innerHTML = (await Promise.all(listings.map((l) => myListingCard(l)))).join('');
    wireMyListingActions(container);
  } catch (err) {
    container.innerHTML = `<div class="status error">${escapeHtml(err.message)}</div>`;
  }
}

async function myListingCard(l) {
  const sessions = l.status === 'open' ? await client.listingSessions(l.id) : [];
  const pending = sessions.filter((s) => s.status === 'requested');
  const active = sessions.filter((s) => s.status !== 'requested');

  const activeHtml = active.length
    ? active.map(sessionRow).join('')
    : pending.length
      ? ''
      : '<p class="muted" style="font-size:.82rem">No testers have joined yet.</p>';

  return `
    <div class="panel" style="padding:.9rem 1rem;margin-bottom:.6rem">
      ${listingCardHeader(l)}
      ${
        pending.length
          ? `<div style="margin-top:.7rem">
               <strong style="font-size:.82rem">Requests to review (${pending.length})</strong>
               ${pending.map(requestCard).join('')}
             </div>`
          : ''
      }
      <div style="margin-top:.6rem">${activeHtml}</div>
      <div style="margin-top:.6rem;display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
        ${
          l.status === 'open'
            ? `<span style="display:flex;gap:.3rem;align-items:center">
                 <input type="number" class="comm-feature-days" data-listing="${l.id}"
                   value="3" min="1" max="14" style="width:4rem">
                 <button class="comm-feature" data-listing="${l.id}">Feature (3 High Fives/day)</button>
               </span>
               <button class="ghost comm-close" data-listing="${l.id}">Close listing</button>`
            : '<span class="pill neutral">Closed</span>'
        }
      </div>
      <div class="comm-listing-status status" data-listing="${l.id}"></div>
    </div>`;
}

function requestCard(s) {
  const rep =
    s.testerCompletedCount > 0
      ? `<span class="pill ok" style="margin-left:.4rem">${s.testerCompletedCount} test${s.testerCompletedCount === 1 ? '' : 's'} completed</span>`
      : '<span class="pill neutral" style="margin-left:.4rem">New tester</span>';
  return `
    <div class="request-card">
      <div class="request-head">
        <span class="request-who">${escapeHtml(s.testerDisplayName || s.testerEmail)}${rep}</span>
      </div>
      <div class="request-message">"${escapeHtml(s.requestMessage)}"</div>
      <div class="request-actions">
        <button class="primary comm-accept" data-session="${s.id}">Accept</button>
        <button class="ghost comm-decline" data-session="${s.id}">Decline</button>
      </div>
    </div>`;
}

function sessionRow(s) {
  const evalBadges = [];
  if (s.bugFound !== null) {
    evalBadges.push(
      `<span class="pill ${s.bugFound ? 'warn' : 'ok'}">${s.bugFound ? 'Bug found' : 'No bugs'}</span>`,
    );
  }
  if (s.wouldUseAgain) {
    evalBadges.push(`<span class="pill neutral">Would use again: ${escapeHtml(s.wouldUseAgain)}</span>`);
  }
  return `
    <div style="padding:.4rem 0;border-top:1px solid var(--border)">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:.6rem">
        <div style="min-width:0">
          <span class="mono" style="font-size:.8rem">${escapeHtml(s.testerDisplayName || s.testerEmail)}</span>
          <span class="pill neutral" style="margin-left:.4rem">${s.status}</span>
          ${evalBadges.length ? `<div class="eval-summary">${evalBadges.join('')}</div>` : ''}
          ${s.feedback ? `<div class="muted" style="font-size:.82rem;margin-top:.2rem">"${escapeHtml(s.feedback)}"</div>` : ''}
        </div>
        ${
          s.status === 'submitted'
            ? `<button class="comm-complete" data-session="${s.id}">Mark complete</button>`
            : ''
        }
      </div>
      ${MESSAGEABLE_STATUSES.has(s.status) ? messageThreadHtml(s.id) : ''}
      ${MESSAGEABLE_STATUSES.has(s.status) ? checkinsToggleHtml(s.id) : ''}
    </div>`;
}

function listingCardHeader(l) {
  const kindLabel = l.kind === 'testing' ? 'Looking for testers' : 'Launch / update';
  return `
    <div style="display:flex;gap:.7rem;align-items:flex-start">
      ${appIcon(l.app.artworkUrl, l.app.name)}
      <div>
        <strong>${escapeHtml(l.app.name)}</strong>
        <span class="pill ${l.kind === 'testing' ? 'info' : 'ok'}" style="margin-left:.4rem">${kindLabel}</span>
        <div class="muted" style="font-size:.82rem">${escapeHtml(l.description || '')}</div>
      </div>
    </div>`;
}

function showListingError(container, listingId, message) {
  const statusEl = container.querySelector(`.comm-listing-status[data-listing="${listingId}"]`);
  if (statusEl) {
    statusEl.className = 'comm-listing-status status error';
    statusEl.textContent = message;
  }
}

/** One handler shape for every per-session button: disable, call, re-render,
 * and put the failure where the user was already looking if it throws. */
function wireSessionAction(container, selector, call) {
  container.querySelectorAll(selector).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const statusEl = btn.closest('.panel')?.querySelector('.comm-listing-status');
      btn.disabled = true;
      try {
        await call(btn);
        await renderMyListings();
      } catch (err) {
        btn.disabled = false;
        if (statusEl) {
          statusEl.className = 'comm-listing-status status error';
          statusEl.textContent = err.message;
        }
      }
    });
  });
}

function wireMyListingActions(container) {
  wireSessionAction(container, '.comm-accept', (btn) => client.acceptSession(btn.dataset.session));
  wireSessionAction(container, '.comm-decline', (btn) => client.declineSession(btn.dataset.session));
  wireSessionAction(container, '.comm-complete', (btn) => client.completeSession(btn.dataset.session));
  wireSessionAction(container, '.comm-close', (btn) => client.closeListing(btn.dataset.listing));
  wireMessageThreads(container);
  wireCheckinsToggles(container);

  container.querySelectorAll('.comm-feature').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const listingId = btn.dataset.listing;
      const daysInput = container.querySelector(`.comm-feature-days[data-listing="${listingId}"]`);
      const days = Number(daysInput?.value);
      if (!Number.isInteger(days) || days < 1 || days > 14) {
        showListingError(container, listingId, 'Enter a number of days between 1 and 14.');
        return;
      }
      btn.disabled = true;
      try {
        await client.featureListing(listingId, days);
        user = { ...user, tokenBalance: user.tokenBalance - days * 3 };
        renderAuthBar();
        await renderMyListings();
      } catch (err) {
        btn.disabled = false;
        showListingError(container, listingId, err.message);
      }
    });
  });
}

/* ---------------------------- message threads ---------------------------- */

export function messageThreadHtml(sessionId) {
  return `
    <div style="margin-top:.4rem">
      <button class="ghost comm-thread-toggle" data-session="${sessionId}" type="button">Messages</button>
      <div class="comm-thread" data-session="${sessionId}" hidden></div>
    </div>`;
}

/** Delegates once per container rather than once per toggle button, so a
 * card list that re-renders (a new session appearing, one changing status)
 * never needs its listeners rewired by hand. */
export function wireMessageThreads(container) {
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.comm-thread-toggle');
    if (btn && container.contains(btn)) toggleThread(btn);
  });
}

async function toggleThread(btn) {
  const id = btn.dataset.session;
  const thread = document.querySelector(`.comm-thread[data-session="${id}"]`);
  if (!thread) return;
  const opening = thread.hidden;
  thread.hidden = !opening;
  if (opening && !thread.dataset.loaded) {
    thread.dataset.loaded = '1';
    await loadThread(id, thread);
  }
}

async function loadThread(id, thread) {
  thread.innerHTML = '<div class="status"><span class="spinner"></span> Loading</div>';
  try {
    renderThread(id, thread, await client.sessionMessages(id));
  } catch (err) {
    thread.innerHTML = `<div class="status error">${escapeHtml(err.message)}</div>`;
  }
}

function renderThread(id, thread, messages) {
  const list = messages.length
    ? messages
        .map(
          (m) => `
        <div class="thread-message${m.senderUserId === user?.id ? ' mine' : ''}">
          <div class="muted" style="font-size:.72rem">${escapeHtml(new Date(m.createdAt).toLocaleString())}</div>
          <div>${escapeHtml(m.body)}</div>
        </div>`,
        )
        .join('')
    : '<p class="muted" style="font-size:.8rem">No messages yet.</p>';

  thread.innerHTML = `
    <div class="thread-list">${list}</div>
    <p class="thread-safety-note" style="padding:0">🔒 Don't share passwords, payment details, or other sensitive information here.</p>
    <div style="display:flex;gap:.4rem;margin-top:.3rem">
      <input type="text" class="comm-thread-input" placeholder="Write a message…" style="flex:1">
      <button class="comm-thread-send">Send</button>
    </div>
    <div class="comm-thread-status status"></div>`;

  const input = thread.querySelector('.comm-thread-input');
  const sendBtn = thread.querySelector('.comm-thread-send');
  const statusEl = thread.querySelector('.comm-thread-status');

  const sendMessage = async () => {
    const body = input.value.trim();
    if (!body) return;
    sendBtn.disabled = true;
    statusEl.textContent = '';
    try {
      await client.sendSessionMessage(id, body);
      input.value = '';
      renderThread(id, thread, await client.sessionMessages(id));
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = err.message;
      sendBtn.disabled = false;
    }
  };
  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage();
  });
}

/* ---------------------------- check-in proof ---------------------------- */

function checkinsToggleHtml(sessionId) {
  return `
    <div style="margin-top:.4rem">
      <button class="ghost comm-checkins-toggle" data-session="${sessionId}" type="button">Check-ins</button>
      <div class="comm-checkins" data-session="${sessionId}" hidden></div>
    </div>`;
}

/** Guarded with a flag on the container itself: `wireMyListingActions` runs
 * again after every accept/decline/complete/close/feature action (each one
 * fully replaces the container's `innerHTML` and re-wires it), and this
 * listener — unlike those per-button ones — is delegated, so wiring it
 * again each time would stack a second `click` handler rather than replace
 * the first. */
function wireCheckinsToggles(container) {
  if (container.dataset.checkinsWired) return;
  container.dataset.checkinsWired = '1';
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.comm-checkins-toggle');
    if (btn && container.contains(btn)) toggleCheckins(btn);
  });
}

async function toggleCheckins(btn) {
  const id = btn.dataset.session;
  const panel = document.querySelector(`.comm-checkins[data-session="${id}"]`);
  if (!panel) return;
  const opening = panel.hidden;
  panel.hidden = !opening;
  if (opening && !panel.dataset.loaded) {
    panel.dataset.loaded = '1';
    await loadCheckins(id, panel);
  }
}

async function loadCheckins(id, panel) {
  panel.innerHTML = '<div class="status"><span class="spinner"></span> Loading</div>';
  try {
    renderCheckins(panel, await client.sessionCheckins(id));
  } catch (err) {
    panel.innerHTML = `<div class="status error">${escapeHtml(err.message)}</div>`;
  }
}

/** Proof, not a preview: full-size in a new tab on click, since a thumbnail
 * this small can't show whether the app screen behind it is legible. */
/** A check-in's photo is purged (not the row) 14 days after its date — see
 * `purgeExpiredPhotos` in community/src/routes/checkins.js — so a `null`
 * photo here is expected on anything that old, not a broken upload. */
function renderCheckins(panel, checkins) {
  if (!checkins.length) {
    panel.innerHTML = '<p class="muted" style="font-size:.8rem">No check-ins yet.</p>';
    return;
  }
  panel.innerHTML = `
    <div class="checkin-proof-grid">
      ${checkins
        .map((c) =>
          c.photo
            ? `
        <a class="checkin-proof" href="${escapeHtml(c.photo)}" target="_blank" rel="noopener">
          <img src="${escapeHtml(c.photo)}" alt="Check-in ${escapeHtml(c.date)}" loading="lazy">
          <span class="muted">${escapeHtml(c.date)}</span>
        </a>`
            : `
        <div class="checkin-proof checkin-proof-purged" title="Photos are kept 14 days">
          <span class="checkin-proof-placeholder">✓</span>
          <span class="muted">${escapeHtml(c.date)}</span>
        </div>`,
        )
        .join('')}
    </div>`;
}

/* ============================ profile tab ============================ */

/**
 * Who you are to everyone else in AppMates — the name, photo and bio shown
 * next to a test request or a chat message, plus the track record
 * (routes/profile.js `stats`) that's earned automatically and can't be
 * edited here, same split as a listing's own reliability badge.
 *
 * The avatar is a pasted link, not an upload: this deployment has no object
 * storage, and a URL field needs none — paste a Gravatar/LinkedIn/whatever
 * link and it just works, same as an app's own artwork URL elsewhere.
 */
function renderProfileTab() {
  if (!user) {
    el('commTabPanel').innerHTML = empty(
      '◍',
      'Sign in to see your profile',
      'Use the box above — this is what testers and builders see before they message you.',
    );
    return;
  }

  const bioLength = (user.bio || '').length;

  el('commTabPanel').innerHTML = `
    <div class="panel" style="padding:1rem 1.2rem;margin-bottom:1rem">
      <h3 style="margin-top:0">My profile</h3>
      <div class="form-grid">
        <label for="commProfileAvatar">Avatar</label>
        <div style="display:flex;gap:.7rem;align-items:center">
          <span id="commProfileAvatarPreview">${iconOrInitial(user.avatarUrl, user.displayName || user.email)}</span>
          <input id="commProfileAvatar" type="text" style="flex:1"
            placeholder="Link to an image (optional)" value="${escapeHtml(user.avatarUrl || '')}">
        </div>
        <label for="commProfileName">Name</label>
        <input id="commProfileName" type="text" maxlength="80" value="${escapeHtml(user.displayName || '')}">
        <label for="commProfileBio">Bio</label>
        <div>
          <textarea id="commProfileBio" rows="3" maxlength="${MAX_BIO_LENGTH}"
            placeholder="What are you building, or what are you looking to test?">${escapeHtml(user.bio || '')}</textarea>
          <div class="muted" style="font-size:.75rem;text-align:right" id="commProfileBioCount">${bioLength}/${MAX_BIO_LENGTH}</div>
        </div>
      </div>
      <div id="commProfileStatus" class="status"></div>
      <button id="commProfileSave" class="primary">Save</button>
    </div>
    <div id="commProfileStats"></div>`;

  el('commProfileAvatar').addEventListener('input', () => {
    el('commProfileAvatarPreview').innerHTML = iconOrInitial(
      el('commProfileAvatar').value.trim(),
      el('commProfileName').value.trim() || user.email,
    );
  });
  el('commProfileBio').addEventListener('input', () => {
    el('commProfileBioCount').textContent = `${el('commProfileBio').value.length}/${MAX_BIO_LENGTH}`;
  });
  el('commProfileSave').addEventListener('click', saveProfile);

  renderProfileStats();
}

async function saveProfile() {
  await withStatus(el('commProfileStatus'), el('commProfileSave'), null, async () => {
    const updated = await client.updateProfile({
      displayName: el('commProfileName').value.trim(),
      bio: el('commProfileBio').value.trim(),
      avatarUrl: el('commProfileAvatar').value.trim(),
    });
    user = updated;
    renderAuthBar();
  });
}

/** The same badges a listing card shows for its owner (`reliabilityBadge`,
 * `contributionBadge`, both from shared.js) — read-only here, since these
 * numbers only ever move by completing or being completed for, never by
 * editing a form. */
async function renderProfileStats() {
  const host = el('commProfileStats');
  if (!host) return;
  host.innerHTML = '<div class="status"><span class="spinner"></span> Loading</div>';
  try {
    const { reliability, contribution } = await client.profileStats();
    host.innerHTML = `
      <div class="panel" style="padding:1rem 1.2rem">
        <h3 style="margin-top:0">Your track record</h3>
        <p class="muted" style="font-size:.82rem;margin:-.4rem 0 0">
          What testers and builders see about you elsewhere in AppMates — earned automatically.
        </p>
        <div style="display:flex;gap:.6rem;flex-wrap:wrap;margin-top:.6rem">
          ${reliabilityBadge(reliability)}
          ${contributionBadge(contribution)}
        </div>
      </div>`;
  } catch (err) {
    host.innerHTML = `<div class="status error">${escapeHtml(err.message)}</div>`;
  }
}
