/** Listing text against both stores' field limits. */

import { validateListing } from '../lib/metadata.js';
import { bar, el, empty, escapeHtml, findingsPanel, pill, tablePanel } from './shared.js';

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
  const values = Object.fromEntries(Object.entries(INPUTS).map(([k, id]) => [k, el(id).value]));

  if (!Object.values(values).some(Boolean)) {
    el('mdSummary').innerHTML = '';
    el('mdFields').innerHTML = empty(
      '¶',
      'Nothing to check yet',
      'Fill in any field above — both stores are checked as you type.',
    );
    el('mdFindings').innerHTML = '';
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
      <span class="muted">${report.errorCount} error(s) · ${report.warningCount} warning(s)</span>
    </div>`;

  const rows = report.fields
    .filter((f) => f.value || f.required)
    .map((f) => {
      const pct = f.maxLength ? (100 * f.length) / f.maxLength : 0;
      const tone = pct > 100 ? 'over' : pct >= 90 ? 'warn' : 'ok';
      return [
        f.store === 'apple' ? 'App Store' : 'Google Play',
        { html: `<strong>${escapeHtml(f.name)}</strong>` },
        { html: bar(pct, tone), tight: true },
        {
          html: `<span class="mono ${tone === 'over' ? 'delta down' : ''}">${f.length}</span><span class="muted mono"> / ${f.maxLength}</span>`,
          num: true,
        },
        { html: f.required ? pill('required', 'info') : '' },
      ];
    });

  el('mdFields').innerHTML = tablePanel({
    title: 'Fields',
    head: ['Store', 'Field', 'Used', { label: 'Characters', num: true }, ''],
    rows,
  });

  el('mdFindings').innerHTML = findingsPanel(report.findings, 'Findings');
}
