/**
 * Every conversation the signed-in user is party to, in one place — a
 * three-pane layout (conversation list, thread, context) rather than the
 * inline collapsible threads `views/community.js` still uses under each
 * session card. Same backend, same messages, just a dedicated home for
 * them instead of a tab buried inside "Get testers".
 */

import { el, escapeHtml, empty, iconOrInitial, showToast, MESSAGEABLE_STATUSES, REPORT_CAUSE_LABELS } from './shared.js';
import { enablePush, listenForInAppToasts, needsPushEnable } from '../lib/push.js';

let client = null;
let user = null;
let conversations = [];
let selectedId = null;
let activeFilter = 'main';

/* ------------------------------ local state -------------------------------- */

// Everything here — seen/favourite/hidden/archived/reported — is this
// device's own view of the inbox, not the backend's. The backend has no
// columns for any of it (reporting aside, which also writes server-side —
// see below); adding them for a single browser's convenience isn't worth a
// migration. The tradeoff is the same one already made for "seen": none of
// this follows you to a second device.
const SEEN_PREFIX = 'appmates:inbox:seen:';
const STATE_PREFIX = 'appmates:inbox:state:';

function seenId(sessionId) {
  try {
    return localStorage.getItem(SEEN_PREFIX + sessionId);
  } catch {
    return null;
  }
}

function markSeen(sessionId, messageId) {
  try {
    localStorage.setItem(SEEN_PREFIX + sessionId, messageId);
  } catch {
    /* private browsing or a full quota — unread state just won't persist */
  }
}

function getConvState(sessionId) {
  try {
    return JSON.parse(localStorage.getItem(STATE_PREFIX + sessionId)) || {};
  } catch {
    return {};
  }
}

function setConvState(sessionId, patch) {
  try {
    localStorage.setItem(STATE_PREFIX + sessionId, JSON.stringify({ ...getConvState(sessionId), ...patch }));
  } catch {
    /* private browsing or a full quota — the action still happened this session, just won't persist */
  }
}

function relativeTime(iso) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function initInbox(communityClient) {
  client = communityClient;

  const navItem = document.querySelector('.nav-item[href="#inbox"]');
  if (!client.configured) {
    navItem?.classList.add('hidden');
    el('inboxShell').innerHTML = empty(
      '✉',
      'Not set up yet',
      'This deployment has no community backend configured. See community/README.md.',
    );
    return;
  }

  // Registered once, independent of which view is open — a push can
  // arrive while the user is looking at Screenshots or Rank, not just here.
  listenForInAppToasts(({ title, body }) => {
    showToast({
      title,
      body,
      onClick: () => {
        location.hash = '#inbox';
        refresh();
      },
    });
  });

  window.addEventListener('hashchange', () => {
    if (location.hash === '#inbox') refresh();
  });

  refresh();
}

async function refresh() {
  try {
    user = await client.me();
    if (!user) {
      el('inboxShell').innerHTML = empty(
        '✉',
        'Sign in to see your messages',
        'Conversations open once a testing request is accepted, on either side. Sign in from the Get testers page.',
      );
      return;
    }
    conversations = await gatherConversations();
    if (selectedId && !conversations.some((c) => c.session.id === selectedId)) selectedId = null;
    renderShell();
  } catch (err) {
    el('inboxShell').innerHTML = `<div class="status error">${escapeHtml(err.message)}</div>`;
  }
}

/**
 * Every messageable session the user is party to, from both sides of the
 * marketplace at once — sessions on listings they own, and sessions where
 * they're the tester. Neither side has its own "all my conversations"
 * endpoint, so this fans out to the per-listing and per-session routes
 * that already exist and flattens the result client-side, rather than
 * adding a new aggregate backend route for what is, in a private beta, a
 * handful of calls.
 */
async function gatherConversations() {
  const [listings, testerSessions, mutedIds] = await Promise.all([
    client.myListings(),
    client.mySessions(),
    client.mutedSessionIds().catch(() => []),
  ]);
  const muted = new Set(mutedIds);

  const ownerConversations = (
    await Promise.all(
      listings.map((l) =>
        client
          .listingSessions(l.id)
          .then((sessions) =>
            sessions.map((s) => ({
              session: s,
              role: 'owner',
              appName: l.app.name,
              artworkUrl: l.app.artworkUrl,
              storeUrl: l.app.storeUrl,
              link: l.link,
              description: l.description,
              platform: l.platform,
              kind: l.kind,
            })),
          )
          .catch(() => []),
      ),
    )
  ).flat();

  const testerConversations = testerSessions.map((s) => ({
    session: s,
    role: 'tester',
    appName: s.listing.appName,
    artworkUrl: s.listing.artworkUrl,
    storeUrl: s.listing.storeUrl,
    link: s.listing.link,
    description: s.listing.description,
    platform: s.listing.platform,
    kind: s.listing.kind,
  }));

  const merged = [...ownerConversations, ...testerConversations].filter((c) =>
    MESSAGEABLE_STATUSES.has(c.session.status),
  );

  const withMessages = await Promise.all(
    merged.map(async (c) => ({ ...c, messages: await client.sessionMessages(c.session.id).catch(() => []) })),
  );

  return withMessages
    .map((c) => {
      const last = c.messages.length ? c.messages[c.messages.length - 1] : null;
      const activityAt = last?.createdAt || c.session.respondedAt || c.session.createdAt;
      const unread = Boolean(last) && last.senderUserId !== user?.id && seenId(c.session.id) !== last.id;
      return { ...c, last, activityAt, unread, muted: muted.has(c.session.id) };
    })
    .sort((a, b) => new Date(b.activityAt) - new Date(a.activityAt));
}

/* ------------------------------- filtering ---------------------------------- */

const FILTER_COPY = {
  main: ['No conversations yet', "They open here once a testing request is accepted — on a listing you own, or one you're testing."],
  completed: ['No completed conversations', "Mark one as completed from its ⋯ menu and it lands here."],
  hidden: ['No hidden conversations', "Hide one from its ⋯ menu and it moves here instead of the main list."],
  reported: ['No reported conversations', "Conversations you've flagged for review show up here."],
};

function conversationsForFilter(filter) {
  return conversations.filter((c) => {
    const state = getConvState(c.session.id);
    if (filter === 'completed') return Boolean(state.archived);
    if (filter === 'hidden') return Boolean(state.hidden) && !state.archived;
    if (filter === 'reported') return Boolean(state.reported);
    return !state.hidden && !state.archived; // 'main'
  });
}

function sortWithFavouritesFirst(list) {
  return [...list].sort((a, b) => {
    const af = getConvState(a.session.id).favorite ? 1 : 0;
    const bf = getConvState(b.session.id).favorite ? 1 : 0;
    if (af !== bf) return bf - af;
    return new Date(b.activityAt) - new Date(a.activityAt);
  });
}

/* --------------------------------- shell ------------------------------------ */

function renderShell() {
  el('inboxShell').innerHTML = `
    <aside class="inbox-list-pane">
      <div class="inbox-list-head">
        <h2>Inbox</h2>
        <select class="inbox-filter-select" id="inboxFilter">
          <option value="main"${activeFilter === 'main' ? ' selected' : ''}>Main</option>
          <option value="completed"${activeFilter === 'completed' ? ' selected' : ''}>Completed</option>
          <option value="hidden"${activeFilter === 'hidden' ? ' selected' : ''}>Hidden</option>
          <option value="reported"${activeFilter === 'reported' ? ' selected' : ''}>Reported</option>
        </select>
      </div>
      <div id="inboxBanners"></div>
      <div class="inbox-list" id="inboxList"></div>
    </aside>
    <div class="inbox-thread-pane" id="inboxThreadPane"></div>
    <aside class="inbox-details-pane" id="inboxDetailsPane"></aside>
  `;
  el('inboxFilter').addEventListener('change', (e) => {
    activeFilter = e.target.value;
    renderList();
  });
  renderBanners();
  renderList();
  renderThreadPane();
  renderDetailsPane();
}

/* ------------------------------- banners --------------------------------- */

async function renderBanners() {
  const host = el('inboxBanners');
  if (!host) return;

  host.innerHTML = (await needsPushEnable())
    ? `
    <div class="callout inbox-banner">
      <span>Get notified in your browser when a message arrives.</span>
      <button class="primary" id="inboxEnablePush" type="button">Enable notifications</button>
    </div>`
    : '';

  el('inboxEnablePush')?.addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
      await enablePush(client);
      btn.closest('.callout')?.remove();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = err.message;
    }
  });
}

/* --------------------------------- list ----------------------------------- */

function renderList() {
  const host = el('inboxList');
  if (!host) return;

  const filtered = sortWithFavouritesFirst(conversationsForFilter(activeFilter));

  if (!filtered.length) {
    const [title, hint] = FILTER_COPY[activeFilter];
    host.innerHTML = empty('✉', title, hint);
    return;
  }

  host.innerHTML = filtered.map(conversationRowHtml).join('');
  host.querySelectorAll('.inbox-row').forEach((row) => {
    row.addEventListener('click', () => selectConversation(row.dataset.session));
  });
}

/** The real name of who you're talking to, when the data actually says —
 * only true for the owner role, since a tester-side session never carries
 * the listing owner's identity. "the app owner" is a placeholder label,
 * not a real name, so it's never used as an avatar-initial source; the
 * app's own name is a better fallback than a meaningless "T". */
function counterpartyName(c) {
  return c.role === 'owner' ? c.session.testerDisplayName || c.session.testerEmail : c.appName;
}

function conversationRowHtml(c) {
  const counterparty = c.role === 'owner' ? c.session.testerDisplayName || c.session.testerEmail : 'the app owner';
  const roleLabel = c.role === 'owner' ? 'Testing your app' : "You're testing";
  const preview = c.last ? escapeHtml(c.last.body).slice(0, 70) : 'No messages yet — say hello.';
  const classes = ['inbox-row', c.unread && 'unread', c.session.id === selectedId && 'selected']
    .filter(Boolean)
    .join(' ');
  const favourite = getConvState(c.session.id).favorite;

  return `
    <button class="${classes}" type="button" data-session="${c.session.id}">
      ${iconOrInitial(c.artworkUrl, counterpartyName(c))}
      <div class="inbox-row-body">
        <div class="inbox-row-head">
          ${favourite ? '<span class="inbox-fav-star" title="Favourite">★</span>' : ''}
          <strong>${escapeHtml(c.appName)}</strong>
          ${c.muted ? '<span class="inbox-muted-icon muted" title="Muted">🔕</span>' : ''}
          ${c.last ? `<span class="inbox-row-time muted">${relativeTime(c.last.createdAt)}</span>` : ''}
        </div>
        <div class="inbox-row-sub muted">${roleLabel} · ${escapeHtml(counterparty)}</div>
        <div class="inbox-row-preview muted">${preview}</div>
      </div>
      ${c.unread ? '<span class="inbox-dot" aria-label="Unread"></span>' : ''}
    </button>`;
}

function selectConversation(id) {
  selectedId = id;
  document.querySelectorAll('.inbox-row').forEach((row) => row.classList.toggle('selected', row.dataset.session === id));

  const conv = conversations.find((c) => c.session.id === id);
  if (conv?.last && conv.unread) {
    markSeen(id, conv.last.id);
    conv.unread = false;
    const row = document.querySelector(`.inbox-row[data-session="${id}"]`);
    row?.classList.remove('unread');
    row?.querySelector('.inbox-dot')?.remove();
  }

  renderThreadPane();
  renderDetailsPane();
}

/* -------------------------------- thread ----------------------------------- */

async function renderThreadPane() {
  const pane = el('inboxThreadPane');
  if (!pane) return;

  const conv = conversations.find((c) => c.session.id === selectedId);
  if (!conv) {
    pane.innerHTML = empty('✉', 'Select a conversation', 'Pick one on the left to read and reply.');
    return;
  }

  const counterparty = conv.role === 'owner' ? conv.session.testerDisplayName || conv.session.testerEmail : 'App owner';
  const state = getConvState(conv.session.id);

  pane.innerHTML = `
    <div class="inbox-thread-head">
      ${iconOrInitial(conv.artworkUrl, counterpartyName(conv))}
      <div class="inbox-thread-head-info">
        <strong>${escapeHtml(conv.appName)}</strong>
        <span class="muted">${escapeHtml(counterparty)}</span>
      </div>
      ${state.reported ? '<span class="pill warn">Reported</span>' : ''}
      <div class="inbox-thread-menu-wrap">
        <button class="ghost inbox-thread-menu-btn" id="inboxThreadMenuBtn" type="button" aria-haspopup="true" aria-expanded="false">⋯</button>
        <div class="inbox-thread-menu hidden" id="inboxThreadMenu"></div>
      </div>
    </div>
    <div class="inbox-thread-messages" id="inboxThreadMessages">
      <div class="status"><span class="spinner"></span> Loading</div>
    </div>
    <p class="thread-safety-note">🔒 Don't share passwords, payment details, or other sensitive information here.</p>
    <div class="inbox-thread-composer">
      <input type="text" id="inboxComposerInput" placeholder="Write a message…">
      <button class="primary" id="inboxComposerSend">Send</button>
    </div>
    <div class="status" id="inboxComposerStatus"></div>`;

  renderThreadMenu(conv);
  renderMessages(conv.messages);
  try {
    const messages = await client.sessionMessages(conv.session.id);
    conv.messages = messages;
    conv.last = messages.length ? messages[messages.length - 1] : null;
    // The user may have switched to a different conversation while this was
    // in flight — `#inboxThreadMessages` now belongs to that other thread,
    // so writing here would silently show this conversation's messages
    // under the wrong header.
    if (selectedId === conv.session.id) renderMessages(messages);
  } catch (err) {
    if (selectedId !== conv.session.id) return;
    const host = el('inboxThreadMessages');
    if (host) host.innerHTML = `<div class="status error">${escapeHtml(err.message)}</div>`;
  }

  const input = el('inboxComposerInput');
  const sendBtn = el('inboxComposerSend');
  const statusEl = el('inboxComposerStatus');

  const send = async () => {
    const body = input.value.trim();
    if (!body) return;
    sendBtn.disabled = true;
    statusEl.textContent = '';
    try {
      await client.sendSessionMessage(conv.session.id, body);
      input.value = '';
      const messages = await client.sessionMessages(conv.session.id);
      conv.messages = messages;
      conv.last = messages.length ? messages[messages.length - 1] : null;
      // Same stale-pane hazard as the initial load: don't overwrite another
      // conversation's thread if the user has since switched away from this one.
      if (selectedId === conv.session.id) renderMessages(messages);
    } catch (err) {
      if (selectedId !== conv.session.id) return;
      statusEl.className = 'status error';
      statusEl.textContent = err.message;
    } finally {
      sendBtn.disabled = false;
    }
  };
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });
}

function renderMessages(messages) {
  const host = el('inboxThreadMessages');
  if (!host) return;
  host.innerHTML = messages.length
    ? messages
        .map(
          (m) => `
        <div class="thread-message${m.senderUserId === user?.id ? ' mine' : ''}">
          <div class="muted" style="font-size:.72rem">${escapeHtml(new Date(m.createdAt).toLocaleString())}</div>
          <div>${escapeHtml(m.body)}</div>
        </div>`,
        )
        .join('')
    : '<p class="muted" style="font-size:.85rem">No messages yet. Say hello.</p>';
  host.scrollTop = host.scrollHeight;
}

/* ----------------------------- thread ⋯ menu --------------------------------- */

function renderThreadMenu(conv) {
  const btn = el('inboxThreadMenuBtn');
  const menu = el('inboxThreadMenu');
  if (!btn || !menu) return;
  const id = conv.session.id;
  const state = getConvState(id);

  menu.innerHTML = `
    <button type="button" class="inbox-menu-item" data-action="favorite">
      ${state.favorite ? '★ Remove from favourites' : '☆ Add to favourites'}
    </button>
    <button type="button" class="inbox-menu-item" data-action="mute">${conv.muted ? '🔔 Unmute' : '🔕 Mute'}</button>
    <button type="button" class="inbox-menu-item" data-action="report">🚩 Report</button>
    <button type="button" class="inbox-menu-item" data-action="hide">${state.hidden ? 'Unhide' : '🙈 Hide'}</button>
    <button type="button" class="inbox-menu-item" data-action="archive">${state.archived ? '↺ Reopen' : '✓ Mark as completed'}</button>`;

  const closeMenu = () => {
    menu.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDocClick);
  };
  const onDocClick = (e) => {
    if (!menu.contains(e.target) && e.target !== btn) closeMenu();
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !opening);
    btn.setAttribute('aria-expanded', String(opening));
    if (opening) document.addEventListener('click', onDocClick);
    else document.removeEventListener('click', onDocClick);
  });

  menu.querySelector('[data-action="favorite"]').addEventListener('click', () => {
    closeMenu();
    setConvState(id, { favorite: !state.favorite });
    renderList();
    renderThreadPane();
  });

  menu.querySelector('[data-action="mute"]').addEventListener('click', async () => {
    closeMenu();
    try {
      if (conv.muted) await client.unmuteSession(id);
      else await client.muteSession(id);
      conv.muted = !conv.muted;
      renderList();
      renderThreadPane();
    } catch (err) {
      console.error('mute toggle failed', err);
    }
  });

  menu.querySelector('[data-action="hide"]').addEventListener('click', () => {
    closeMenu();
    setConvState(id, { hidden: !state.hidden });
    afterMembershipChange(id);
  });

  menu.querySelector('[data-action="archive"]').addEventListener('click', () => {
    closeMenu();
    setConvState(id, { archived: !state.archived });
    afterMembershipChange(id);
  });

  menu.querySelector('[data-action="report"]').addEventListener('click', () => {
    closeMenu();
    openReportModal(conv);
  });
}

function openReportModal(conv) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'inboxReportModal';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="inboxReportTitle">
      <div class="modal-head">
        <div>
          <h3 id="inboxReportTitle">Report this conversation</h3>
          <p class="modal-sub">Reviewed by hand — invisible to the other person, and doesn't change anything about the conversation itself.</p>
        </div>
        <button class="modal-close" type="button" aria-label="Close">✕</button>
      </div>
      <div class="modal-fields">
        <div class="field">
          <label>Reason</label>
          <div class="report-cause-list">
            ${Object.entries(REPORT_CAUSE_LABELS)
              .map(
                ([value, label], i) => `
              <label class="report-cause-option">
                <input type="radio" name="inboxReportCause" value="${value}"${i === 0 ? ' checked' : ''}>
                ${escapeHtml(label)}
              </label>`,
              )
              .join('')}
          </div>
        </div>
        <div class="field">
          <label for="inboxReportExplanation">Explain what happened</label>
          <textarea id="inboxReportExplanation" rows="3" placeholder="At least 10 characters"></textarea>
        </div>
        <div class="field">
          <label for="inboxReportEvidence">Evidence <span class="muted">(optional — links, specific message quotes, anything that helps)</span></label>
          <textarea id="inboxReportEvidence" rows="2"></textarea>
        </div>
      </div>
      <div id="inboxReportStatus" class="status"></div>
      <button id="inboxReportSubmit" class="primary" style="width:100%;margin-top:.5rem">Send report</button>
    </div>`;
  document.body.appendChild(overlay);

  const closeReportModal = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKeydown);
  };
  const onKeydown = (e) => {
    if (e.key === 'Escape') closeReportModal();
  };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeReportModal();
  });
  overlay.querySelector('.modal-close').addEventListener('click', closeReportModal);
  document.addEventListener('keydown', onKeydown);
  el('inboxReportExplanation').focus();

  el('inboxReportSubmit').addEventListener('click', async () => {
    const cause = overlay.querySelector('input[name="inboxReportCause"]:checked')?.value;
    const reason = el('inboxReportExplanation').value.trim();
    const evidence = el('inboxReportEvidence').value.trim();
    const statusEl = el('inboxReportStatus');

    if (reason.length < 10) {
      statusEl.className = 'status error';
      statusEl.textContent = 'Please write at least 10 characters explaining what happened.';
      return;
    }

    const btn = el('inboxReportSubmit');
    btn.disabled = true;
    statusEl.textContent = '';
    try {
      await client.reportSession(conv.session.id, { cause, reason, evidence });
      setConvState(conv.session.id, { reported: true });
      closeReportModal();
      renderList();
      renderThreadPane();
    } catch (err) {
      btn.disabled = false;
      statusEl.className = 'status error';
      statusEl.textContent = err.message;
    }
  });
}

function afterMembershipChange(id) {
  renderList();
  if (selectedId !== id) return;
  const stillVisible = conversationsForFilter(activeFilter).some((c) => c.session.id === id);
  if (!stillVisible) {
    selectedId = null;
    renderThreadPane();
    renderDetailsPane();
  } else {
    renderThreadPane();
  }
}

/* -------------------------------- details ---------------------------------- */

const STATUS_LABEL = {
  accepted: 'Accepted — active',
  submitted: 'Feedback submitted',
  completed: 'Completed',
};

function platformLabel(p) {
  return p === 'ios' ? 'iOS' : p === 'android' ? 'Android' : 'iOS & Android';
}

function testerReliabilityBadge(count) {
  if (!count) return '<span class="pill neutral">New tester</span>';
  return `<span class="pill ok">${count} test${count === 1 ? '' : 's'} completed</span>`;
}

function feedbackBadgesHtml(s) {
  const badges = [];
  if (s.bugFound !== null && s.bugFound !== undefined) {
    badges.push(`<span class="pill ${s.bugFound ? 'warn' : 'ok'}">${s.bugFound ? 'Bug found' : 'No bugs'}</span>`);
  }
  if (s.wouldUseAgain) {
    badges.push(`<span class="pill neutral">Would use again: ${escapeHtml(s.wouldUseAgain)}</span>`);
  }
  return badges.length ? `<div class="inbox-detail-facts" style="margin-top:.5rem">${badges.join('')}</div>` : '';
}

/**
 * What the right pane shows before any conversation is picked — an empty
 * panel read as "broken," not "nothing selected yet." Every number here is
 * already in memory (the conversation list, `user` from `client.me()`),
 * so this costs nothing extra to compute.
 */
function idleDetailsHtml() {
  const total = conversations.length;
  const unread = conversations.filter((c) => c.unread).length;
  const favourites = conversations.filter((c) => getConvState(c.session.id).favorite).length;
  const owner = conversations.filter((c) => c.role === 'owner').length;
  const tester = conversations.filter((c) => c.role === 'tester').length;

  const overviewCard = `
    <div class="inbox-detail-card">
      <div class="inbox-detail-label">Overview</div>
      <div class="inbox-detail-facts">
        <span class="pill neutral">${total} conversation${total === 1 ? '' : 's'}</span>
        ${unread ? `<span class="pill info">${unread} unread</span>` : ''}
        ${favourites ? `<span class="pill warn">${favourites} favourite${favourites === 1 ? '' : 's'}</span>` : ''}
      </div>
      ${total ? `<p class="muted inbox-detail-desc">${owner} on apps you own · ${tester} you're testing</p>` : ''}
    </div>`;

  const tokensCard = user
    ? `
    <div class="inbox-detail-card">
      <div class="inbox-detail-label">Tokens</div>
      <strong>${user.tokenBalance}</strong>
      <p class="muted inbox-detail-desc">Earned by testing other people's apps — spend them to feature your own listing.</p>
    </div>`
    : '';

  const guardrailCard = `
    <div class="inbox-detail-card">
      <div class="inbox-detail-label">Keep in mind</div>
      <p class="muted inbox-detail-desc">Nobody here trades App Store or Play reviews — testers give private feedback on a
      build, and whether anyone reviews your app is between them and the store. Keep passwords, payment details, and
      other sensitive information out of messages too.</p>
    </div>`;

  return overviewCard + tokensCard + guardrailCard;
}

/**
 * The right pane — deliberately not a full dump of every field: a card for
 * the app being tested (with the one link a tester actually needs to open
 * the build), a card for the other person when there's anything real to
 * show about them, and the session's own facts. Nothing here is fetched
 * specially; it's all data the list already had.
 */
function renderDetailsPane() {
  const pane = el('inboxDetailsPane');
  if (!pane) return;

  const conv = conversations.find((c) => c.session.id === selectedId);
  if (!conv) {
    pane.innerHTML = idleDetailsHtml();
    return;
  }

  const { session: s, role } = conv;

  const appCard = `
    <div class="inbox-detail-card">
      ${iconOrInitial(conv.artworkUrl, conv.appName)}
      <strong>${escapeHtml(conv.appName)}</strong>
      <div class="inbox-detail-pills">
        ${conv.kind ? `<span class="pill ${conv.kind === 'testing' ? 'info' : 'ok'}">${conv.kind === 'testing' ? 'Looking for testers' : 'Launch / update'}</span>` : ''}
        ${conv.platform ? `<span class="pill neutral">${platformLabel(conv.platform)}</span>` : ''}
      </div>
      ${conv.description ? `<p class="muted inbox-detail-desc">${escapeHtml(conv.description)}</p>` : ''}
      <div class="inbox-detail-links">
        ${role === 'tester' && conv.link ? `<a href="${escapeHtml(conv.link)}" target="_blank" rel="noopener">Open build link →</a>` : ''}
        ${conv.storeUrl ? `<a href="${escapeHtml(conv.storeUrl)}" target="_blank" rel="noopener">View on store →</a>` : ''}
      </div>
    </div>`;

  const personCard =
    role === 'owner'
      ? `
    <div class="inbox-detail-card">
      <div class="inbox-detail-label">Tester</div>
      <strong>${escapeHtml(s.testerDisplayName || s.testerEmail)}</strong>
      ${testerReliabilityBadge(s.testerCompletedCount)}
      ${s.requestMessage ? `<p class="muted inbox-detail-desc">"${escapeHtml(s.requestMessage)}"</p>` : ''}
    </div>`
      : '';

  const factsCard = `
    <div class="inbox-detail-card">
      <div class="inbox-detail-label">Session</div>
      <div class="inbox-detail-facts">
        <span class="pill neutral">${STATUS_LABEL[s.status] || s.status}</span>
        <span class="muted">Started ${relativeTime(s.createdAt)}</span>
      </div>
      ${feedbackBadgesHtml(s)}
    </div>`;

  pane.innerHTML = appCard + personCard + factsCard;
}
