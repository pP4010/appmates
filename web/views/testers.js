/** Google Play closed-testing progress. */

import { evaluateTesting, flatHistory, parseHistory } from '../lib/testers.js';
import { el, escapeHtml, findingsPanel, pill, ring, tablePanel } from './shared.js';

export function initTesters() {
  for (const id of ['testDays', 'testCount', 'testApproved']) {
    el(id).addEventListener('input', renderFlat);
    el(id).addEventListener('change', renderFlat);
  }
  el('testHistory').addEventListener('input', renderTimeline);
  renderFlat();
}

function renderFlat() {
  const days = Math.max(0, Number(el('testDays').value) || 0);
  const testers = Math.max(0, Number(el('testCount').value) || 0);
  const approved = el('testApproved').value === 'yes';

  const status = evaluateTesting(flatHistory(days, testers), { releaseApproved: approved });
  el('testResults').innerHTML =
    render(status) +
    `<p class="note">A flat "${days} days at ${testers} testers" cannot see a dip by
     construction. If your count ever dropped, paste the timeline below — the streak that
     matters is the unbroken one.</p>`;
}

function renderTimeline() {
  const raw = el('testHistory').value.trim();
  const statusEl = el('testHistoryStatus');

  if (!raw) {
    statusEl.className = 'status';
    statusEl.innerHTML = '';
    renderFlat();
    return;
  }

  try {
    const history = parseHistory(raw);
    statusEl.className = 'status';
    statusEl.innerHTML = '';
    el('testResults').innerHTML =
      render(evaluateTesting(history)) +
      `<p class="note">Evaluated from your ${history.length}-day timeline.</p>`;
  } catch (err) {
    statusEl.className = 'status error';
    statusEl.textContent = err.message;
  }
}

function render(status) {
  const tone = status.eligible ? 'pass' : status.wasReset ? 'fail' : 'warn';
  const verdict = status.eligible ? 'Eligible to apply' : 'Not yet eligible';

  const rows = [
    [
      'Testers opted in',
      {
        html: `<strong>${status.activeTesters}</strong> <span class="muted">/ ${status.requiredTesters}</span>`,
        num: true,
      },
    ],
    [
      'Continuous days',
      {
        html: `<strong>${status.currentStreakDays}</strong> <span class="muted">/ ${status.requiredDays}</span>`,
        num: true,
      },
    ],
    ['Longest streak', { html: `${status.longestStreakDays} days`, num: true }],
  ];
  if (status.streakStart) rows.push(['Streak started', { html: `<span class="mono">${status.streakStart}</span>`, num: true }]);
  if (status.projectedDate) rows.push(['Projected date', { html: `<span class="mono">${status.projectedDate}</span>`, num: true }]);

  const blockers = status.blockers.map((b) => ({
    code: b.code,
    // The reset is the one that costs two weeks, so it reads as an error while
    // the others are simply "not there yet".
    severity: b.code === 'STREAK_RESET' ? 'error' : 'warning',
    message: b.message,
  }));

  return `
    <div class="summary ${tone}">
      ${ring(status.progress, { size: 44, stroke: 4, thresholds: [99.9, 1], label: `${status.progress}% complete` })}
      <span>
        <span class="verdict">${verdict}</span><br>
        <span class="muted">${status.currentStreakDays} of ${status.requiredDays} continuous days ·
        ${status.activeTesters} of ${status.requiredTesters} testers</span>
      </span>
      <span style="margin-left:auto">${
        status.wasReset ? pill('clock was restarted', 'bad') : pill(`${status.progress}%`, tone === 'pass' ? 'ok' : 'warn')
      }</span>
    </div>
    ${tablePanel({ head: ['Measure', { label: 'Value', num: true }], rows })}
    ${findingsPanel(blockers, 'What is blocking you')}`;
}

export { escapeHtml };
