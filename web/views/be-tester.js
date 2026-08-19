/**
 * Apps you're testing for other developers — the tester half of the
 * Community feature, split out from "Get testers" (the owner half) into
 * its own page since the two are different jobs done by different people
 * at different moments, even though the same account does both.
 *
 * The one thing this adds beyond what used to live in community.js's
 * dashboard: a daily proof-of-testing check-in. A `submitted`/`completed`
 * session already carries a feedback write-up, but nothing between
 * accepting and submitting says whether the tester actually opened the
 * app more than once. A check-in — a photo of the app open, one per day,
 * `UNIQUE(session_id, checkin_date)` server-side — is a cheap, real signal
 * the listing owner can see building up, the same habit-tracker shape as
 * Play's own 12-testers-14-days streak (lib/testers.js), just from the
 * tester's side this time.
 */

import { el, empty, escapeHtml, appIcon, MESSAGEABLE_STATUSES } from './shared.js';
import { messageThreadHtml, wireMessageThreads } from './community.js';

const STATUS_LABEL = {
  requested: 'Waiting for review',
  declined: 'Declined',
  accepted: 'Accepted — go test it',
  submitted: 'Feedback submitted',
  completed: 'Completed',
  abandoned: 'Abandoned',
};

const STATUS_TONE = {
  requested: 'neutral',
  declined: 'bad',
  accepted: 'info',
  submitted: 'neutral',
  completed: 'ok',
  abandoned: 'neutral',
};

const STRIP_DAYS = 14;
const MAX_PHOTO_DIMENSION = 640;
const PHOTO_QUALITY = 0.6;
// A screenshot is a few MB at most; this is generous headroom over that so
// a real screenshot always sails through, while still stopping something
// picked by mistake (a multi-hundred-MB video or RAW photo) from being
// read into memory at all before compression even starts.
const MAX_SOURCE_FILE_BYTES = 25 * 1024 * 1024;

let client = null;
let user = null;

export function initBeTester(communityClient) {
  client = communityClient;
  const navItem = document.querySelector('.nav-item[href="#be-tester"]');

  if (!client.configured) {
    navItem?.classList.add('hidden');
    el('testerBody').innerHTML = empty(
      '◑',
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
    render();
  } catch (err) {
    el('testerBody').innerHTML = `<div class="status error">${escapeHtml(err.message)}</div>`;
  }
}

function render() {
  if (!user) {
    el('testerBody').innerHTML = empty(
      '◑',
      'Sign in to see your testing',
      'Sign in from Get testers — the two pages share one account.',
    );
    return;
  }
  el('testerBody').innerHTML = '<div id="testerSessions"></div>';
  // Delegated listeners, wired exactly once on this stable container — it
  // gets its `innerHTML` replaced on every re-render (a submitted review, a
  // fresh check-in) but the element itself never does, so wiring these
  // again on each re-render would stack a second listener on top of the
  // first rather than replacing it.
  wireDelegatedActions(el('testerSessions'));
  renderSessions();
}

async function renderSessions() {
  const container = el('testerSessions');
  container.innerHTML = '<div class="status"><span class="spinner"></span> Loading</div>';
  try {
    const sessions = await client.mySessions();
    if (!sessions.length) {
      container.innerHTML = empty(
        '◑',
        "You haven't requested to test anything yet",
        'Find something on the Get testers → Marketplace tab.',
      );
      return;
    }
    container.innerHTML = (await Promise.all(sessions.map(sessionCard))).join('');
    wireSubmitButtons(container);
  } catch (err) {
    container.innerHTML = `<div class="status error">${escapeHtml(err.message)}</div>`;
  }
}

async function sessionCard(s) {
  const tone = STATUS_TONE[s.status] || 'neutral';
  const label = STATUS_LABEL[s.status] || s.status;

  let body = '';
  if (s.status === 'requested') {
    body = `<div class="muted" style="font-size:.82rem;margin-top:.3rem">"${escapeHtml(s.requestMessage)}"</div>`;
  } else if (s.status === 'accepted') {
    const checkins = await client.sessionCheckins(s.id).catch(() => []);
    body = `
      <div class="checkin-widget" data-session="${s.id}">
        ${checkinStripHtml(s.id, checkins, s.respondedAt)}
      </div>
      <div style="margin-top:.5rem">
        <textarea class="comm-feedback-input" data-session="${s.id}" rows="2"
          placeholder="What did you find? Bugs, confusing steps, first impressions..."
          style="width:100%"></textarea>
        <div class="eval-fields">
          <label><input type="checkbox" class="comm-bug-found" data-session="${s.id}"> Found a blocking bug</label>
          <label>Would use again:
            <select class="comm-would-use-again" data-session="${s.id}" style="width:auto">
              <option value="">—</option>
              <option value="yes">Yes</option>
              <option value="maybe">Maybe</option>
              <option value="no">No</option>
            </select>
          </label>
        </div>
        <button class="primary comm-submit" data-session="${s.id}">Submit feedback</button>
        <div class="comm-session-status status" data-session="${s.id}"></div>
      </div>`;
  } else if (s.status === 'submitted' || s.status === 'completed') {
    body = `<div class="muted" style="font-size:.82rem;margin-top:.3rem">"${escapeHtml(s.feedback ?? '')}"</div>`;
  }

  return `
    <div class="panel" style="padding:.9rem 1rem;margin-bottom:.6rem">
      <div style="display:flex;gap:.7rem;align-items:flex-start">
        ${appIcon(s.listing.artworkUrl, s.listing.appName)}
        <div style="flex:1;min-width:0">
          <strong>${escapeHtml(s.listing.appName)}</strong>
          <span class="pill ${tone}" style="margin-left:.4rem">${label}</span>
          ${body}
          ${s.status === 'completed' ? '<div class="muted" style="font-size:.78rem">+1 token awarded</div>' : ''}
          ${MESSAGEABLE_STATUSES.has(s.status) ? messageThreadHtml(s.id) : ''}
        </div>
      </div>
    </div>`;
}

/** The last `STRIP_DAYS` days (or fewer, if the test hasn't run that long
 * yet), oldest first, one dot each — done/missed/today, the same at-a-
 * glance shape as a habit tracker's own streak calendar. */
function checkinStripHtml(sessionId, checkins, acceptedAt) {
  const done = new Set(checkins.map((c) => c.date));
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const earliest = acceptedAt ? new Date(acceptedAt) : today;
  const start = new Date(Math.max(earliest.getTime(), today.getTime() - (STRIP_DAYS - 1) * 86_400_000));

  const days = [];
  for (let d = new Date(start.toISOString().slice(0, 10)); d <= today; d.setDate(d.getDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    days.push({ iso, done: done.has(iso), isToday: iso === todayIso });
  }

  const checkedInToday = done.has(todayIso);
  const streak = currentStreak(checkins, todayIso);

  return `
    <div class="checkin-strip-row">
      <div class="checkin-strip" id="checkin-strip-${sessionId}">
        ${days
          .map(
            (d) =>
              `<span class="checkin-day ${d.done ? 'done' : ''} ${d.isToday ? 'today' : ''}" title="${d.iso}${d.done ? ' — checked in' : ''}"></span>`,
          )
          .join('')}
      </div>
      <span class="muted" style="font-size:.76rem">${streak > 0 ? `${streak}-day streak` : 'No check-ins yet'}</span>
    </div>
    <label class="ghost checkin-upload-label ${checkedInToday ? 'disabled' : ''}">
      ${checkedInToday ? '✓ Checked in today' : '📷 Check in today'}
      <input type="file" accept="image/*" class="checkin-file-input" data-session="${sessionId}"
        data-accepted="${escapeHtml(acceptedAt ?? '')}" ${checkedInToday ? 'disabled' : ''} hidden>
    </label>
    <div class="checkin-status status" data-session="${sessionId}"></div>`;
}

/** Consecutive days ending today (or yesterday, if today's check-in just
 * hasn't happened yet — a streak isn't broken until a day is actually
 * missed, and the day isn't over). */
function currentStreak(checkins, todayIso) {
  const done = new Set(checkins.map((c) => c.date));
  let cursor = done.has(todayIso) ? new Date(todayIso) : new Date(Date.now() - 86_400_000);
  let streak = 0;
  while (done.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor = new Date(cursor.getTime() - 86_400_000);
  }
  return streak;
}

/** Downscales and re-encodes client-side so a phone's multi-MB screenshot
 * becomes a data URL comfortably under the server's MAX_CHECKIN_PHOTO_CHARS
 * — proof doesn't need to be full resolution, just legible. */
function compressPhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That does not look like an image.'));
      img.onload = () => {
        const scale = Math.min(1, MAX_PHOTO_DIMENSION / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', PHOTO_QUALITY));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/** Delegated listeners — wired exactly once (see the call site in `render`),
 * so they never need re-wiring as the container's content changes underneath
 * them. */
function wireDelegatedActions(container) {
  wireMessageThreads(container);

  // `submitCheckin` replaces just the one widget it touched rather than the
  // whole list, so this — unlike `wireSubmitButtons` below — has to be
  // delegated: an input wired individually would need re-wiring after every
  // check-in and risk a second listener stacking onto everything that
  // didn't change.
  container.addEventListener('change', (e) => {
    const input = e.target.closest('.checkin-file-input');
    if (input && container.contains(input)) submitCheckin(container, input);
  });
}

/** Per-button — safe to call after every full re-render (`renderSessions`
 * replaces the container's entire `innerHTML`, so these are always fresh
 * elements, never already-wired ones). */
function wireSubmitButtons(container) {
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
      const bugFoundEl = container.querySelector(`.comm-bug-found[data-session="${id}"]`);
      const wouldUseAgainEl = container.querySelector(`.comm-would-use-again[data-session="${id}"]`);
      btn.disabled = true;
      try {
        await client.submitSession(id, {
          feedback,
          bugFound: bugFoundEl?.checked ?? false,
          wouldUseAgain: wouldUseAgainEl?.value || undefined,
        });
        await renderSessions();
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

async function submitCheckin(container, input) {
  const file = input.files[0];
  if (!file) return;
  const id = input.dataset.session;
  const acceptedAt = input.dataset.accepted;
  const statusEl = container.querySelector(`.checkin-status[data-session="${id}"]`);

  if (file.size > MAX_SOURCE_FILE_BYTES) {
    statusEl.className = 'checkin-status status error';
    statusEl.textContent = 'That file is too large — pick a screenshot, not a video or a RAW photo.';
    input.value = '';
    return;
  }

  statusEl.className = 'checkin-status status';
  statusEl.innerHTML = '<span class="spinner"></span> Uploading';
  try {
    const photo = await compressPhoto(file);
    const date = new Date().toISOString().slice(0, 10);
    await client.submitCheckin(id, { date, photo });
    statusEl.className = 'checkin-status status';
    statusEl.textContent = '';

    const checkins = await client.sessionCheckins(id);
    const widget = container.querySelector(`.checkin-widget[data-session="${id}"]`);
    if (widget) {
      widget.outerHTML = `<div class="checkin-widget" data-session="${id}">${checkinStripHtml(id, checkins, acceptedAt)}</div>`;
    }
  } catch (err) {
    statusEl.className = 'checkin-status status error';
    statusEl.textContent = err.message;
  } finally {
    input.value = '';
  }
}
