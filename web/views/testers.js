/**
 * Every test you're running — App Store or Play — as one list instead of a
 * single Play-only calculator. A test is (app, store, invite link) plus
 * whatever progress that store tracks: Play's 12-testers-for-14-days streak,
 * or TestFlight's 90-day build expiry. Both stores share the one thing this
 * page can't do for you: a tester can't open the link until you've added
 * them by hand in that store's console first, so every test's detail leads
 * with that reminder rather than pretending the link alone is enough.
 */

import { evaluateTesting, flatHistory, parseHistory, testFlightExpiry } from '../lib/testers.js';
import { testsStore } from '../lib/tests-store.js';
import { favorites } from '../lib/favorites.js';
import { el, empty, escapeHtml, findingsPanel, iconOrInitial, pill, ring, tablePanel } from './shared.js';

// The actual store icons (icons8), not a hand-drawn approximation.
const APPLE_IMG = '<img src="./assets/app-store.png" alt="App Store" width="14" height="14">';
const PLAY_IMG = '<img src="./assets/google-play.png" alt="Google Play" width="14" height="14">';
const STORE_ICON = { apple: APPLE_IMG, google: PLAY_IMG };
const STORE_LABEL = { apple: 'App Store · TestFlight', google: 'Google Play · Closed testing' };

let expandedId = null;
let formOpen = false;
let formApp = null;
let formStore = 'apple';
let formAppName = '';
let formLink = '';

export function initTesters() {
  el('testNewBtn').addEventListener('click', () => {
    formOpen = true;
    formApp = null;
    formStore = 'apple';
    formAppName = '';
    formLink = '';
    renderForm();
  });
  el('testForm').addEventListener('click', handleFormClick);
  el('testForm').addEventListener('input', handleFormInput);
  el('testList').addEventListener('click', handleListClick);
  el('testList').addEventListener('input', handleListInput);
  renderList();
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/* ============================ create form ============================ */

function renderForm() {
  const form = el('testForm');
  form.classList.toggle('hidden', !formOpen);
  if (!formOpen) {
    form.innerHTML = '';
    return;
  }

  const favList = favorites.list();
  const appPicker = formApp
    ? `<div class="test-app-selected">${iconOrInitial(formApp.artwork, formApp.name)}
        <strong>${escapeHtml(formApp.name)}</strong>
        <button type="button" class="ghost" id="testFormClearApp">✕</button></div>`
    : `${
        favList.length
          ? `<div class="fav-pick-row" id="testFormFavRow">${favList
              .map(
                (a) => `<button type="button" class="fav-pick" data-track-id="${escapeHtml(a.trackId)}"
                  title="${escapeHtml(a.name)}">${iconOrInitial(a.artwork, a.name)}</button>`,
              )
              .join('')}</div>`
          : ''
      }
      <input id="testFormAppName" type="text" placeholder="Or type an app name" value="${escapeHtml(formAppName)}">`;

  form.innerHTML = `
    <strong>New test</strong>
    <div class="form-grid" style="grid-template-columns:1fr; margin:.6rem 0 0; padding:0; border:none; background:none">
      <label>App</label>
      ${appPicker}
      <label>Store</label>
      <div class="store-toggle">
        <button type="button" class="store-toggle-btn ${formStore === 'apple' ? 'active' : ''}" data-store="apple">${APPLE_IMG} App Store</button>
        <button type="button" class="store-toggle-btn ${formStore === 'google' ? 'active' : ''}" data-store="google">${PLAY_IMG} Google Play</button>
      </div>
      <label for="testFormLink">Invite link</label>
      <input id="testFormLink" type="text" value="${escapeHtml(formLink)}"
        placeholder="${formStore === 'apple' ? 'https://testflight.apple.com/join/xxxxxxxx' : 'https://play.google.com/apps/testing/com.example.app'}">
    </div>
    <div id="testFormError" class="status"></div>
    <div class="toolbar" style="margin-top:1rem">
      <button type="button" class="ghost" id="testFormCancel">Cancel</button>
      <button type="button" class="primary" id="testFormSave">Save test</button>
    </div>`;
}

function handleFormClick(e) {
  const fav = e.target.closest('.fav-pick');
  if (fav) {
    const all = favorites.list();
    formApp = all.find((a) => String(a.trackId) === fav.dataset.trackId) ?? null;
    renderForm();
    return;
  }
  if (e.target.id === 'testFormClearApp') {
    formApp = null;
    renderForm();
    return;
  }
  const storeBtn = e.target.closest('[data-store]');
  if (storeBtn) {
    formStore = storeBtn.dataset.store;
    renderForm();
    return;
  }
  if (e.target.id === 'testFormCancel') {
    formOpen = false;
    renderForm();
    return;
  }
  if (e.target.id === 'testFormSave') saveNewTest();
}

function handleFormInput(e) {
  if (e.target.id === 'testFormAppName') formAppName = e.target.value;
  if (e.target.id === 'testFormLink') formLink = e.target.value;
}

function saveNewTest() {
  const app = formApp ?? (formAppName.trim() ? { name: formAppName.trim(), artwork: null } : null);
  if (!app) {
    const errEl = el('testFormError');
    errEl.className = 'status error';
    errEl.textContent = 'Pick a favorite or type an app name first.';
    return;
  }

  const test = testsStore.save({
    store: formStore,
    app,
    inviteLink: formLink.trim(),
    createdAt: todayIso(),
    google: { daysPassed: 0, testersCount: 0, releaseApproved: true, historyText: '' },
    apple: { testersCount: 0, uploadedAt: todayIso(), publicLink: true },
  });

  formOpen = false;
  expandedId = test.id;
  renderForm();
  renderList();
}

/* ============================ list ============================ */

function renderList() {
  const tests = testsStore.list();
  el('testList').innerHTML = tests.length
    ? tests.map(testCard).join('')
    : empty('◇', 'No tests yet', 'Click "+ New test" to track your first App Store or Play test.');
}

function testCard(test) {
  const expanded = test.id === expandedId;
  return `
    <div class="test-card ${expanded ? 'expanded' : ''}">
      <button type="button" class="test-card-head" data-toggle="${test.id}">
        <span class="test-icon-badge">
          ${iconOrInitial(test.app.artwork, test.app.name)}
          <span class="store-badge ${test.store}">${STORE_ICON[test.store]}</span>
        </span>
        <span class="test-card-body">
          <strong>${escapeHtml(test.app.name)}</strong>
          <span class="muted">${STORE_LABEL[test.store]}</span>
        </span>
        <span id="test-${test.id}-pill">${statusPill(test)}</span>
        <span class="test-card-chevron">${expanded ? '▾' : '▸'}</span>
      </button>
      ${expanded ? testDetail(test) : ''}
    </div>`;
}

function statusPill(test) {
  if (test.store === 'google') {
    const status = evaluateGoogle(test);
    return status.eligible
      ? pill('eligible', 'ok')
      : pill(`${status.activeTesters}/${status.requiredTesters} · day ${status.currentStreakDays}/${status.requiredDays}`, status.wasReset ? 'bad' : 'warn');
  }
  const exp = testFlightExpiry(test.apple.uploadedAt);
  if (exp.expired) return pill('build expired', 'bad');
  return pill(`${exp.daysLeft}d left · ${test.apple.testersCount} testers`, exp.daysLeft <= 14 ? 'warn' : 'ok');
}

function checklistFor(test) {
  return test.store === 'apple'
    ? test.apple.publicLink
      ? 'Public link: anyone who has it can join (up to 10,000 testers) — nothing to add in App Store Connect first. Just share the link below.'
      : "Individual testers: add each tester's Apple ID email under App Store Connect → TestFlight → Testers before they can accept this invite."
    : "Add every tester's Google account email to this test's tester list in Play Console first — the link below only works for accounts already on that list.";
}

function testDetail(test) {
  return `
    <div class="test-detail">
      <div class="callout" id="test-${test.id}-checklist">${checklistFor(test)}</div>
      <div class="invite-row">
        <input type="text" data-field="inviteLink" data-id="${test.id}" value="${escapeHtml(test.inviteLink || '')}" placeholder="Paste the invite link">
        <button type="button" class="copy-btn" data-copy="${test.id}" title="Copy invite link">⧉</button>
      </div>
      ${test.store === 'google' ? googleFields(test) : appleFields(test)}
      <div class="toolbar" style="margin-top:.75rem">
        <button type="button" class="ghost" data-remove="${test.id}">Delete test</button>
      </div>
    </div>`;
}

function googleFields(test) {
  const g = test.google;
  return `
    <div class="toolbar" style="margin:.85rem 0 0">
      <div class="field">
        <label>Days passed</label>
        <input type="number" min="0" max="120" data-field="daysPassed" data-id="${test.id}" value="${g.daysPassed}" style="width:6rem">
      </div>
      <div class="field">
        <label>Testers opted in</label>
        <input type="number" min="0" max="500" data-field="testersCount" data-id="${test.id}" value="${g.testersCount}" style="width:7rem">
      </div>
      <div class="field">
        <label>Release approved</label>
        <select data-field="releaseApproved" data-id="${test.id}">
          <option value="yes" ${g.releaseApproved ? 'selected' : ''}>Yes</option>
          <option value="no" ${!g.releaseApproved ? 'selected' : ''}>Not yet</option>
        </select>
      </div>
    </div>
    <div id="test-${test.id}-results">${googleResults(test)}</div>
    <details class="test-timeline">
      <summary>Paste a day-by-day timeline instead — catches a dip a flat count can't see</summary>
      <textarea data-field="historyText" data-id="${test.id}" rows="4"
        placeholder='[{"date":"2026-07-01","opted_in":12}, {"date":"2026-07-02","opted_in":11}]'>${escapeHtml(g.historyText || '')}</textarea>
      <div class="status" id="test-${test.id}-history-status"></div>
    </details>`;
}

function appleFields(test) {
  const a = test.apple;
  return `
    <div class="toolbar" style="margin:.85rem 0 0">
      <div class="field">
        <label>Build uploaded</label>
        <input type="date" data-field="uploadedAt" data-id="${test.id}" value="${a.uploadedAt}">
      </div>
      <div class="field">
        <label>Testers added</label>
        <input type="number" min="0" max="10000" data-field="testersCount" data-id="${test.id}" value="${a.testersCount}" style="width:7rem">
      </div>
      <div class="field">
        <label>Link type</label>
        <select data-field="publicLink" data-id="${test.id}">
          <option value="yes" ${a.publicLink ? 'selected' : ''}>Public link</option>
          <option value="no" ${!a.publicLink ? 'selected' : ''}>Individual testers</option>
        </select>
      </div>
    </div>
    <div id="test-${test.id}-results">${appleResults(test)}</div>`;
}

function evaluateGoogle(test) {
  const g = test.google;
  if (g.historyText?.trim()) {
    try {
      return evaluateTesting(parseHistory(g.historyText));
    } catch {
      /* falls through to the flat estimate below */
    }
  }
  return evaluateTesting(flatHistory(g.daysPassed, g.testersCount), { releaseApproved: g.releaseApproved });
}

function googleResults(test) {
  const g = test.google;
  let historyError = '';
  let status;
  if (g.historyText?.trim()) {
    try {
      status = evaluateTesting(parseHistory(g.historyText));
    } catch (err) {
      historyError = err.message;
      status = evaluateTesting(flatHistory(g.daysPassed, g.testersCount), { releaseApproved: g.releaseApproved });
    }
  } else {
    status = evaluateTesting(flatHistory(g.daysPassed, g.testersCount), { releaseApproved: g.releaseApproved });
  }

  const tone = status.eligible ? 'pass' : status.wasReset ? 'fail' : 'warn';
  const verdict = status.eligible ? 'Eligible to apply' : 'Not yet eligible';
  const rows = [
    ['Testers opted in', { html: `<strong>${status.activeTesters}</strong> <span class="muted">/ ${status.requiredTesters}</span>`, num: true }],
    ['Continuous days', { html: `<strong>${status.currentStreakDays}</strong> <span class="muted">/ ${status.requiredDays}</span>`, num: true }],
    ['Longest streak', { html: `${status.longestStreakDays} days`, num: true }],
  ];
  if (status.streakStart) rows.push(['Streak started', { html: `<span class="mono">${status.streakStart}</span>`, num: true }]);
  if (status.projectedDate) rows.push(['Projected date', { html: `<span class="mono">${status.projectedDate}</span>`, num: true }]);

  const blockers = status.blockers.map((b) => ({
    code: b.code,
    severity: b.code === 'STREAK_RESET' ? 'error' : 'warning',
    message: b.message,
  }));

  if (historyError) el(`test-${test.id}-history-status`)?.classList.add('error');

  return `
    <div class="summary ${tone}">
      ${ring(status.progress, { size: 40, stroke: 4, thresholds: [99.9, 1], label: `${status.progress}% complete` })}
      <span><span class="verdict">${verdict}</span><br>
        <span class="muted">${status.currentStreakDays} of ${status.requiredDays} days · ${status.activeTesters} of ${status.requiredTesters} testers</span></span>
      <span style="margin-left:auto">${status.wasReset ? pill('clock restarted', 'bad') : pill(`${status.progress}%`, tone === 'pass' ? 'ok' : 'warn')}</span>
    </div>
    ${tablePanel({ head: ['Measure', { label: 'Value', num: true }], rows })}
    ${findingsPanel(blockers, 'What is blocking you')}
    ${historyError ? `<p class="note" style="color:var(--bad)">${escapeHtml(historyError)}</p>` : ''}`;
}

function appleResults(test) {
  const a = test.apple;
  const exp = testFlightExpiry(a.uploadedAt);
  const tone = exp.expired ? 'fail' : exp.daysLeft <= 14 ? 'warn' : 'pass';
  const verdict = exp.expired ? 'Build expired' : 'Build active';

  return `
    <div class="summary ${tone}">
      ${ring(Math.max(0, Math.min(100, (exp.daysLeft / 90) * 100)), { size: 40, stroke: 4, thresholds: [50, 15], label: `${exp.daysLeft} days left` })}
      <span><span class="verdict">${verdict}</span><br>
        <span class="muted">${a.testersCount} tester${a.testersCount === 1 ? '' : 's'} · ${a.publicLink ? 'public link' : 'individual'}</span></span>
      <span style="margin-left:auto">${exp.expired ? pill('expired', 'bad') : pill(`${exp.daysLeft}d left`, tone === 'pass' ? 'ok' : 'warn')}</span>
    </div>
    ${tablePanel({
      head: ['Measure', { label: 'Value', num: true }],
      rows: [
        ['Build uploaded', { html: `<span class="mono">${escapeHtml(a.uploadedAt)}</span>`, num: true }],
        ['Expires', { html: `<span class="mono">${exp.expiresOn}</span>`, num: true }],
        ['Testers added', { html: String(a.testersCount), num: true }],
      ],
    })}
    <p class="note">Builds stop being testable 90 days after upload regardless of tester count.
      ${!a.publicLink ? ' A first build to a new external group also needs Apple’s Beta App Review before testers can install it.' : ''}</p>`;
}

/* ============================ list interaction ============================ */

function handleListClick(e) {
  const remove = e.target.closest('[data-remove]');
  if (remove) {
    testsStore.remove(remove.dataset.remove);
    if (expandedId === remove.dataset.remove) expandedId = null;
    renderList();
    return;
  }
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    const input = copy.closest('.invite-row').querySelector('input');
    navigator.clipboard?.writeText(input.value).then(() => {
      copy.classList.add('copied');
      setTimeout(() => copy.classList.remove('copied'), 1200);
    }).catch(() => {
      /* clipboard denied; the link is still selectable text in the field */
    });
    return;
  }
  const toggle = e.target.closest('[data-toggle]');
  if (toggle) {
    expandedId = expandedId === toggle.dataset.toggle ? null : toggle.dataset.toggle;
    renderList();
  }
}

function handleListInput(e) {
  const id = e.target.dataset.id;
  const field = e.target.dataset.field;
  if (!id || !field) return;
  const test = testsStore.get(id);
  if (!test) return;

  if (field === 'inviteLink') {
    test.inviteLink = e.target.value;
    testsStore.save(test);
    return;
  }

  if (test.store === 'google') {
    if (field === 'daysPassed') test.google.daysPassed = Math.max(0, Number(e.target.value) || 0);
    if (field === 'testersCount') test.google.testersCount = Math.max(0, Number(e.target.value) || 0);
    if (field === 'releaseApproved') test.google.releaseApproved = e.target.value === 'yes';
    if (field === 'historyText') test.google.historyText = e.target.value;
    testsStore.save(test);
    el(`test-${id}-results`).innerHTML = googleResults(test);
  } else {
    if (field === 'uploadedAt') test.apple.uploadedAt = e.target.value;
    if (field === 'testersCount') test.apple.testersCount = Math.max(0, Number(e.target.value) || 0);
    if (field === 'publicLink') test.apple.publicLink = e.target.value === 'yes';
    testsStore.save(test);
    el(`test-${id}-results`).innerHTML = appleResults(test);
    if (field === 'publicLink') el(`test-${id}-checklist`).innerHTML = checklistFor(test);
  }
  const pillSlot = el(`test-${id}-pill`);
  if (pillSlot) pillSlot.innerHTML = statusPill(test);
}
