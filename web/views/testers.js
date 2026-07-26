/** Google Play closed-testing progress. */

import { evaluateTesting, flatHistory, parseHistory } from '../lib/testers.js';
import { el, escapeHtml, meter, table } from './shared.js';

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
     construction. If your count ever dropped, paste the timeline below — the
     streak that matters is the unbroken one.</p>`;
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
    const status = evaluateTesting(history);
    statusEl.className = 'status';
    statusEl.innerHTML = '';
    el('testResults').innerHTML =
      render(status) + `<p class="note">Evaluated from your ${history.length}-day timeline.</p>`;
  } catch (err) {
    statusEl.className = 'status error';
    statusEl.textContent = err.message;
  }
}

function render(status) {
  const verdict = status.eligible ? 'Eligible to apply' : 'Not yet eligible';
  const tone = status.eligible ? 'pass' : status.wasReset ? 'fail' : 'warn';

  const rows = [
    ['Testers opted in', `${status.activeTesters} / ${status.requiredTesters}`],
    ['Continuous days', `${status.currentStreakDays} / ${status.requiredDays}`],
    ['Longest streak', `${status.longestStreakDays} days`],
    [
      'Progress',
      {
        html: `${meter(status.progress, { width: 20, thresholds: [99.9, 1] })} ${status.progress}%`,
      },
    ],
  ];
  if (status.projectedDate) rows.push(['Projected date', status.projectedDate]);
  if (status.streakStart) rows.push(['Streak started', status.streakStart]);

  const blockers = status.blockers.length
    ? `<div class="card"><div class="findings">${status.blockers
        .map(
          (b) => `<div class="finding ${b.code === 'STREAK_RESET' ? 'error' : 'warning'}">
            <span class="code">${escapeHtml(b.code)}</span>
            <span class="msg">${escapeHtml(b.message)}</span>
          </div>`,
        )
        .join('')}</div></div>`
    : '';

  return `
    <div class="summary ${tone}">
      <span class="verdict">${verdict}</span>
      ${status.wasReset ? '<span class="muted">· the clock was restarted at least once</span>' : ''}
    </div>
    ${table({ head: ['Measure', 'Value'], rows })}
    ${blockers}`;
}
