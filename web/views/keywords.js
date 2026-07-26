/** The 100-character App Store keyword field. */

import { auditField } from '../lib/keywords.js';
import { el, escapeHtml, findingHtml, lines, meter } from './shared.js';

export function initKeywords() {
  for (const id of ['kwTitle', 'kwSubtitle', 'kwField', 'kwTargets']) {
    el(id).addEventListener('input', render);
  }
}

function render() {
  const targets = lines(el('kwTargets'));
  const field = el('kwField').value;

  if (!field && !targets.length) {
    for (const id of ['kwBudget', 'kwFindings', 'kwCoverage', 'kwSuggestion']) {
      el(id).innerHTML = '';
    }
    return;
  }

  const report = auditField(field, {
    title: el('kwTitle').value,
    subtitle: el('kwSubtitle').value,
    targets,
  });

  const over = report.length > report.maxLength;
  // Coloured by waste, not by fill. A field comfortably under 100 characters
  // while throwing half of them away is not a green state, and a green bar is
  // exactly what stops someone reading the findings underneath.
  const tone = over ? 'over' : report.wastedCharacters ? 'warn' : 'ok';
  const filled = Math.round((30 * Math.min(report.length, report.maxLength)) / report.maxLength);

  el('kwBudget').innerHTML = `
    <div class="budget-line">
      <span class="meter ${tone}">${'█'.repeat(filled)}${'░'.repeat(30 - filled)}</span>
      <span><strong>${report.length}</strong>/${report.maxLength} characters</span>
      ${
        report.wastedCharacters
          ? `<span style="color:var(--warning)">${report.wastedCharacters} wasted</span>`
          : '<span style="color:var(--success)">nothing wasted</span>'
      }
    </div>`;

  el('kwFindings').innerHTML = report.findings.length
    ? `<div class="card"><div class="findings">${report.findings.map(findingHtml).join('')}</div></div>`
    : '';

  el('kwCoverage').innerHTML = report.coverage.length
    ? `<h2>Can you rank for these?</h2><div class="card"><div class="findings">${report.coverage
        .map((c) =>
          c.covered
            ? `<div class="finding info">
                 <span class="msg"><strong>${escapeHtml(c.phrase)}</strong> — reachable</span>
                 <div class="hint">indexed from ${Object.entries(c.coveredBy)
                   .map(([k, v]) => `${k} (${v.join(', ')})`)
                   .join(', ')}</div>
               </div>`
            : `<div class="finding error">
                 <span class="msg"><strong>${escapeHtml(c.phrase)}</strong> — not reachable</span>
                 <div class="hint">missing: ${c.missingWords.map(escapeHtml).join(', ')}</div>
               </div>`,
        )
        .join('')}</div></div>`
    : '';

  if (report.suggestedField && report.suggestedField !== field) {
    const saved = report.length - report.suggestedField.length;
    el('kwSuggestion').innerHTML = `
      <div class="suggestion">
        <strong>Suggested field</strong>
        <code>${escapeHtml(report.suggestedField)}</code>
        <span class="mono muted">${report.suggestedField.length}/${report.maxLength} characters${
          saved > 0 ? ` · ${saved} reclaimed` : ''
        }</span>
        <button id="kwCopy" style="margin-left:.75rem">Copy</button>
      </div>`;
    el('kwCopy').addEventListener('click', async (e) => {
      await navigator.clipboard.writeText(report.suggestedField);
      e.target.textContent = 'Copied';
      setTimeout(() => (e.target.textContent = 'Copy'), 1500);
    });
  } else {
    el('kwSuggestion').innerHTML = '';
  }
}

export { meter };
