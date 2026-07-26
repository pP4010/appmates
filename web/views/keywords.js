/** The 100-character App Store keyword field. */

import { auditField } from '../lib/keywords.js';
import { bar, el, escapeHtml, findingsPanel, lines, pill } from './shared.js';

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
  const pct = (100 * report.length) / report.maxLength;

  el('kwBudget').innerHTML = `
    <div class="budget">
      <span><strong style="font-size:1.05rem">${report.length}</strong>
        <span class="muted">/ ${report.maxLength} characters</span></span>
      ${bar(pct, tone)}
      ${
        report.wastedCharacters
          ? pill(`${report.wastedCharacters} wasted`, 'warn')
          : pill('nothing wasted', 'ok')
      }
    </div>`;

  el('kwFindings').innerHTML = findingsPanel(report.findings, 'What the field is spending on');

  el('kwCoverage').innerHTML = report.coverage.length
    ? `<div class="panel">
        <div class="panel-head">Can you rank for these?</div>
        <div class="table-wrap"><table><tbody>${report.coverage
          .map(
            (c) => `<tr>
              <td><strong>${escapeHtml(c.phrase)}</strong></td>
              <td>${c.covered ? pill('reachable', 'ok') : pill('not reachable', 'bad')}</td>
              <td class="muted" style="font-size:.8rem">${
                c.covered
                  ? `indexed from ${Object.entries(c.coveredBy).map(([k, v]) => `${k} (${v.join(', ')})`).join(', ')}`
                  : `missing: ${c.missingWords.map(escapeHtml).join(', ')}`
              }</td>
            </tr>`,
          )
          .join('')}</tbody></table></div>
      </div>`
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

