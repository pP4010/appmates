/**
 * Get real testers before you ship, real users at launch.
 *
 * The one view in this app that needs an account — see the callout in
 * index.html for why that's scoped to exactly this feature. Everything
 * here talks to `community/`, a separate backend from the screenshot
 * relay; if it isn't deployed and configured, this view says so instead of
 * failing silently.
 */

import { el, escapeHtml, empty, withStatus, appIcon } from './shared.js';

let client = null;
let getCurrentApp = null;
let user = null;

export function initCommunity(communityClient, { getCurrentApp: getApp } = {}) {
  client = communityClient;
  getCurrentApp = getApp || (() => null);

  const navItem = document.querySelector('.nav-item[href="#community"]');

  if (!client.configured) {
    navItem?.classList.add('hidden');
    el('commSignedOut').innerHTML = empty(
      '◍',
      'Not set up yet',
      'This deployment has no community backend configured. See community/README.md.',
    );
    return;
  }

  el('commSendLink').addEventListener('click', sendLink);
  el('commEmail').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendLink();
  });

  refreshSession();
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

async function refreshSession() {
  user = await client.me();
  el('commSignedOut').classList.toggle('hidden', Boolean(user));
  el('commSignedIn').classList.toggle('hidden', !user);
  if (user) await renderDashboard();
}

function renderDashboard() {
  el('commBody').innerHTML = `
    <div class="summary pass">
      <span class="verdict">Signed in as ${escapeHtml(user.email)}</span>
      <span class="muted">${user.tokenBalance} token${user.tokenBalance === 1 ? '' : 's'}</span>
      <button id="commLogout" class="ghost" style="margin-left:auto">Sign out</button>
    </div>

    <h3>Get testers or announce a launch</h3>
    <div id="commCreatePanel"></div>

    <h3>Browse open listings</h3>
    <div class="toolbar">
      <div class="field">
        <label for="commBrowseKind">Show</label>
        <select id="commBrowseKind">
          <option value="">Everything</option>
          <option value="testing">Looking for testers</option>
          <option value="launch">Just launched / updated</option>
        </select>
      </div>
      <button id="commBrowseRefresh">Refresh</button>
    </div>
    <div id="commBrowseResults"></div>

    <h3>Your listings</h3>
    <div id="commMyListings"></div>

    <h3>Apps you're testing</h3>
    <div id="commMySessions"></div>`;

  el('commLogout').addEventListener('click', async () => {
    await client.logout();
    user = null;
    await refreshSession();
  });
  el('commBrowseRefresh').addEventListener('click', renderBrowse);
  el('commBrowseKind').addEventListener('change', renderBrowse);

  renderCreatePanel();
  renderBrowse();
  renderMyListings();
  renderMySessions();
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
    await renderBrowse();
  });
}

async function renderBrowse() {
  const results = el('commBrowseResults');
  results.innerHTML = '<div class="status"><span class="spinner"></span> Loading</div>';
  try {
    const kind = el('commBrowseKind').value || undefined;
    const listings = await client.browseListings(kind);
    results.innerHTML = listings.length
      ? listings.map((l) => listingCard(l, { canJoin: l.kind === 'testing' })).join('')
      : empty('◍', 'Nothing here yet', 'Be the first to post a listing.');
    wireJoinButtons(results);
  } catch (err) {
    results.innerHTML = `<div class="status error">${escapeHtml(err.message)}</div>`;
  }
}

function listingCard(l, { canJoin = false } = {}) {
  const kindLabel = l.kind === 'testing' ? 'Looking for testers' : 'Launch / update';
  const featured = l.featuredUntil && new Date(l.featuredUntil) > new Date();
  return `
    <div class="panel" style="padding:.9rem 1rem;margin-bottom:.6rem">
      <div style="display:flex;gap:.7rem;align-items:flex-start">
        ${appIcon(l.app.artworkUrl, l.app.name)}
        <div style="flex:1;min-width:0">
          <strong>${escapeHtml(l.app.name)}</strong>
          <span class="pill ${l.kind === 'testing' ? 'info' : 'ok'}" style="margin-left:.4rem">${kindLabel}</span>
          ${featured ? '<span class="pill warn" style="margin-left:.3rem">Featured</span>' : ''}
          <div class="muted" style="font-size:.85rem;margin-top:.2rem">${escapeHtml(l.description || '')}</div>
          <div class="muted" style="font-size:.78rem;margin-top:.3rem">
            ${l.kind === 'testing' ? `${l.slotsFilled}/${l.slotsWanted} testers · ` : ''}
            <a href="${escapeHtml(l.link)}" target="_blank" rel="noopener">Open link ↗</a>
          </div>
        </div>
        ${canJoin ? `<button class="primary comm-join" data-listing="${l.id}">Join to test</button>` : ''}
      </div>
    </div>`;
}

function wireJoinButtons(container) {
  container.querySelectorAll('.comm-join').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await client.joinListing(btn.dataset.listing);
        btn.textContent = 'Joined';
        await renderMySessions();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = err.message;
      }
    });
  });
}

async function renderMyListings() {
  const container = el('commMyListings');
  container.innerHTML = '<div class="status"><span class="spinner"></span> Loading</div>';
  try {
    const listings = await client.myListings();
    if (!listings.length) {
      container.innerHTML = empty('◍', 'No listings yet', 'Post one above.');
      return;
    }
    container.innerHTML = (
      await Promise.all(listings.map((l) => myListingCard(l)))
    ).join('');
    wireMyListingActions(container);
  } catch (err) {
    container.innerHTML = `<div class="status error">${escapeHtml(err.message)}</div>`;
  }
}

async function myListingCard(l) {
  const sessions = l.status === 'open' ? await client.listingSessions(l.id) : [];
  const rows = sessions
    .map(
      (s) => `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:.6rem;padding:.4rem 0;border-top:1px solid var(--border)">
      <div style="min-width:0">
        <span class="mono" style="font-size:.8rem">${escapeHtml(s.testerEmail)}</span>
        <span class="pill neutral" style="margin-left:.4rem">${s.status}</span>
        ${s.feedback ? `<div class="muted" style="font-size:.82rem;margin-top:.2rem">"${escapeHtml(s.feedback)}"</div>` : ''}
      </div>
      ${
        s.status === 'submitted'
          ? `<button class="comm-complete" data-session="${s.id}">Mark complete</button>`
          : ''
      }
    </div>`,
    )
    .join('');

  return `
    <div class="panel" style="padding:.9rem 1rem;margin-bottom:.6rem">
      ${listingCardHeader(l)}
      <div style="margin-top:.5rem">
        ${rows || '<p class="muted" style="font-size:.82rem">No testers have joined yet.</p>'}
      </div>
      <div style="margin-top:.6rem;display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
        ${
          l.status === 'open'
            ? `<span style="display:flex;gap:.3rem;align-items:center">
                 <input type="number" class="comm-feature-days" data-listing="${l.id}"
                   value="3" min="1" max="14" style="width:4rem">
                 <button class="comm-feature" data-listing="${l.id}">Feature (3 tokens/day)</button>
               </span>
               <button class="ghost comm-close" data-listing="${l.id}">Close listing</button>`
            : '<span class="pill neutral">Closed</span>'
        }
      </div>
      <div class="comm-listing-status status" data-listing="${l.id}"></div>
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

function listingStatusEl(container, listingId) {
  return container.querySelector(`.comm-listing-status[data-listing="${listingId}"]`);
}

function showListingError(container, listingId, message) {
  const statusEl = listingStatusEl(container, listingId);
  if (statusEl) {
    statusEl.className = 'comm-listing-status status error';
    statusEl.textContent = message;
  }
}

function wireMyListingActions(container) {
  container.querySelectorAll('.comm-complete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const statusEl = btn.closest('.panel')?.querySelector('.comm-listing-status');
      btn.disabled = true;
      try {
        await client.completeSession(btn.dataset.session);
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
  container.querySelectorAll('.comm-close').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await client.closeListing(btn.dataset.listing);
        await renderMyListings();
      } catch (err) {
        btn.disabled = false;
        showListingError(container, btn.dataset.listing, err.message);
      }
    });
  });
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
        await renderDashboard();
      } catch (err) {
        btn.disabled = false;
        showListingError(container, listingId, err.message);
      }
    });
  });
}

async function renderMySessions() {
  const container = el('commMySessions');
  container.innerHTML = '<div class="status"><span class="spinner"></span> Loading</div>';
  try {
    const sessions = await client.mySessions();
    if (!sessions.length) {
      container.innerHTML = empty('◍', "You haven't joined anything yet", 'Browse listings above.');
      return;
    }
    container.innerHTML = sessions.map(mySessionCard).join('');
    wireMySessionActions(container);
  } catch (err) {
    container.innerHTML = `<div class="status error">${escapeHtml(err.message)}</div>`;
  }
}

function mySessionCard(s) {
  return `
    <div class="panel" style="padding:.9rem 1rem;margin-bottom:.6rem">
      <div style="display:flex;gap:.7rem;align-items:flex-start">
        ${appIcon(s.listing.artworkUrl, s.listing.appName)}
        <div style="flex:1;min-width:0">
          <strong>${escapeHtml(s.listing.appName)}</strong>
          <span class="pill neutral" style="margin-left:.4rem">${s.status}</span>
          ${
            s.status === 'joined'
              ? `<div style="margin-top:.5rem">
                   <textarea class="comm-feedback-input" data-session="${s.id}" rows="2"
                     placeholder="What did you find? Bugs, confusing steps, first impressions..."
                     style="width:100%"></textarea>
                   <button class="primary comm-submit" data-session="${s.id}">Submit feedback</button>
                   <div class="comm-session-status status" data-session="${s.id}"></div>
                 </div>`
              : `<div class="muted" style="font-size:.82rem;margin-top:.3rem">"${escapeHtml(s.feedback ?? '')}"</div>`
          }
          ${s.status === 'completed' ? '<div class="muted" style="font-size:.78rem">+1 token awarded</div>' : ''}
        </div>
      </div>
    </div>`;
}

function wireMySessionActions(container) {
  container.querySelectorAll('.comm-submit').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.session;
      const textarea = container.querySelector(`.comm-feedback-input[data-session="${id}"]`);
      const statusEl = container.querySelector(`.comm-session-status[data-session="${id}"]`);
      const feedback = textarea.value.trim();
      if (!feedback) {
        if (statusEl) {
          statusEl.className = 'comm-session-status status error';
          statusEl.textContent = 'Write a few words about what you found first.';
        }
        return;
      }
      btn.disabled = true;
      try {
        await client.submitSession(id, feedback);
        await renderMySessions();
      } catch (err) {
        btn.disabled = false;
        if (statusEl) {
          statusEl.className = 'comm-session-status status error';
          statusEl.textContent = err.message;
        }
      }
    });
  });
}
