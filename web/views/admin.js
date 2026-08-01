/**
 * Admin inbox: review "Feature your app here" requests submitted from the
 * landing page's promo dialog. Approving or rejecting here is the entire
 * publish step — an approved request is what `renderRails` in `landing.js`
 * reads (via `CommunityClient#featuredPromoSlots`) to put a card on the
 * page, no redeploy required.
 *
 * Not linked from the sidebar nav — reached only by typing `#admin` — since
 * it's meaningful to one person, not a feature for every signed-in user.
 * The actual gate is server-side (`isAdmin` in the Worker, allowlisted by
 * `env.ADMIN_EMAILS`); this view only reads that answer back through a
 * 403 and gets out of the way if it's "no". Never trust a client-side
 * check alone for something a stranger could otherwise read.
 */

import { el, escapeHtml, empty, withStatus } from './shared.js';

let client = null;
let user = null;

export function initAdmin(communityClient) {
  client = communityClient;
  if (!client.configured) {
    el('adminBody').innerHTML = empty(
      '☰',
      'Not set up yet',
      'This deployment has no community backend configured. See community/README.md.',
    );
    return;
  }
  refresh();
}

async function refresh() {
  try {
    user = await client.me();
  } catch (err) {
    el('adminBody').innerHTML = `<div class="status error">${escapeHtml(err.message)}</div>`;
    return;
  }
  if (!user) {
    renderSignIn();
    return;
  }
  loadRequests();
}

function renderSignIn() {
  el('adminBody').innerHTML = `
    <div class="toolbar" style="margin-bottom:1.2rem">
      <div class="field" style="flex:1;min-width:14rem">
        <label for="adminEmail">Sign in as an admin</label>
        <input id="adminEmail" type="email" placeholder="you@example.com">
      </div>
      <button id="adminSendLink">Send sign-in link</button>
    </div>
    <div id="adminAuthStatus" class="status"></div>`;

  const sendLink = async () => {
    const email = el('adminEmail').value.trim();
    if (!email) return;
    await withStatus(el('adminAuthStatus'), el('adminSendLink'), null, async (say) => {
      say('Sending link');
      await client.requestLink(email);
      el('adminAuthStatus').className = 'status';
      el('adminAuthStatus').innerHTML =
        `<span class="muted">Check <strong>${escapeHtml(email)}</strong> for a sign-in link. ` +
        'Signing in only unlocks this inbox if that email is on the admin list.</span>';
    });
  };
  el('adminSendLink').addEventListener('click', sendLink);
  el('adminEmail').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendLink();
  });
}

async function loadRequests() {
  el('adminBody').innerHTML = '<div class="status"><span class="spinner"></span> Loading…</div>';

  let requests;
  try {
    requests = await client.adminListPromoRequests();
  } catch (err) {
    if (err.status === 403) {
      el('adminBody').innerHTML = empty(
        '🔒',
        'Not authorized',
        `Signed in as ${user.email}, which isn't on the admin list for this deployment.`,
      );
      return;
    }
    el('adminBody').innerHTML = `<div class="status error">${escapeHtml(err.message)}</div>`;
    return;
  }
  renderRequests(requests);
}

function requestCard(r) {
  const tone = r.status === 'approved' ? 'pass' : r.status === 'rejected' ? 'fail' : 'warn';
  const artwork = r.artworkUrl
    ? `<img src="${escapeHtml(r.artworkUrl)}" alt="" width="40" height="40" style="border-radius:8px;display:block">`
    : '';
  return `
    <div class="panel" style="margin-bottom:.9rem;padding:1rem" data-request="${escapeHtml(r.id)}">
      <div style="display:flex;justify-content:space-between;gap:1rem;align-items:flex-start">
        <div style="display:flex;gap:.7rem;align-items:flex-start">
          ${artwork}
          <div>
            <strong>${escapeHtml(r.appName)}</strong>
            <span class="muted">${r.appGenre ? ` · ${escapeHtml(r.appGenre)}` : ''} · card colour: ${escapeHtml(r.color)}</span>
            <div class="muted" style="font-size:.8rem;margin-top:.2rem">
              ${escapeHtml(r.requesterName)} · ${escapeHtml(r.requesterEmail)} ·
              ${escapeHtml(new Date(r.createdAt).toLocaleDateString())}
            </div>
          </div>
        </div>
        <span class="summary ${tone}" style="margin:0;padding:.35rem .6rem">
          <span class="verdict">${escapeHtml(r.status)}</span>
        </span>
      </div>
      <p style="white-space:pre-wrap;font-size:.86rem;margin:.7rem 0 0">${escapeHtml(r.message)}</p>
      ${
        r.status === 'pending'
          ? `<div style="display:flex;gap:.6rem;margin-top:.8rem">
               <button class="primary" data-action="approve" data-id="${escapeHtml(r.id)}">Approve</button>
               <button data-action="reject" data-id="${escapeHtml(r.id)}">Reject</button>
             </div>
             <div class="status" data-status-for="${escapeHtml(r.id)}"></div>`
          : ''
      }
    </div>`;
}

function renderRequests(requests) {
  if (!requests.length) {
    el('adminBody').innerHTML = empty(
      '📥',
      'Nothing yet',
      'Requests submitted through the landing page’s "Feature your app here" dialog will show up here.',
    );
    return;
  }

  el('adminBody').innerHTML = requests.map(requestCard).join('');
  el('adminBody').querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => review(btn.dataset.id, btn.dataset.action, btn));
  });
}

async function review(id, action, btn) {
  const card = btn.closest('[data-request]');
  const statusEl = card.querySelector(`[data-status-for="${id}"]`);
  card.querySelectorAll('button').forEach((b) => (b.disabled = true));
  statusEl.className = 'status';
  statusEl.innerHTML = '<span class="spinner"></span> Working…';

  try {
    await client.adminReviewPromoRequest(id, action);
  } catch (err) {
    statusEl.className = 'status error';
    statusEl.textContent = err.message;
    card.querySelectorAll('button').forEach((b) => (b.disabled = false));
    return;
  }
  loadRequests();
}
