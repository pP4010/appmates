/** Listing text against both stores' field limits. */

import { validateListing } from '../lib/metadata.js';
import { el, escapeHtml, findingsCard, meter, table } from './shared.js';

const INPUTS = {
  title: 'mdTitle',
  subtitle: 'mdSubtitle',
  short_description: 'mdShort',
  promotional_text: 'mdPromo',
  keywords: 'mdKeywords',
  description: 'mdDescription',
};

export function initMetadata() {
  for (const id of Object.values(INPUTS)) el(id).addEventListener('input', render);
  render();
}

function render() {
  const values = Object.fromEntries(
    Object.entries(INPUTS).map(([key, id]) => [key, el(id).value]),
  );
  const anyFilled = Object.values(values).some(Boolean);

  if (!anyFilled) {
    for (const id of ['mdSummary', 'mdFields', 'mdFindings']) el(id).innerHTML = '';
    return;
  }

  const report = validateListing(values);
  const verdict =
    report.status === 'pass'
      ? 'Within every limit'
      : report.status === 'warn'
        ? 'Within limits, but tight'
        : 'Over a limit';

  el('mdSummary').innerHTML = `
    <div class="summary ${report.status}">
      <span class="verdict">${verdict}</span>
      <span class="muted">· ${report.errorCount} error(s) · ${report.warningCount} warning(s)</span>
    </div>`;

  const rows = report.fields
    .filter((f) => f.value || f.required)
    .map((f) => {
      const pct = f.maxLength ? (100 * f.length) / f.maxLength : 0;
      return [
        f.store === 'apple' ? 'App Store' : 'Google Play',
        escapeHtml(f.name),
        { html: meter(100 - Math.min(pct, 100), { width: 14, thresholds: [30, 0.001] }), num: false },
        { html: `${f.length} / ${f.maxLength}`, num: true },
      ];
    });

  el('mdFields').innerHTML = rows.length
    ? table({ head: ['Store', 'Field', 'Used', { label: 'Characters', num: true }], rows })
    : '';

  el('mdFindings').innerHTML = findingsCard(report.findings);
}
