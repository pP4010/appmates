/**
 * Submission readiness — one go/no-go answer, composed from whatever you've
 * already entered on the Screenshots, Keyword field and Listing text pages.
 *
 * Nothing is re-typed here on purpose: this view reads those pages' own DOM
 * inputs directly (they exist in the document whether visible or not, since
 * routing only toggles a CSS class) and their own live-updating engines, the
 * same "fill the app card once, prefill everywhere" idea `app.js` already
 * uses. Mirrors `core/services/submission_checker.check_submission`.
 */

import { validateListing } from '../lib/metadata.js';
import { auditField } from '../lib/keywords.js';
import { getSelectedStores } from './metadata.js';
import { screenshotSummary } from './screenshots.js';
import { el, empty, findingsPanel, lines, pill, ring, tablePanel } from './shared.js';

const METADATA_INPUTS = {
  title: 'mdTitle',
  subtitle: 'mdSubtitle',
  short_description: 'mdShort',
  promotional_text: 'mdPromo',
  keywords: 'mdKeywords',
  description: 'mdDescription',
};

export function initReadiness() {
  // These fields already have their own live-update listeners on the
  // Screenshots/Keywords/Metadata views; adding this render as a second
  // listener keeps Readiness current while it's the visible tab too.
  for (const id of [
    ...Object.values(METADATA_INPUTS),
    'kwField',
    'kwTitle',
    'kwSubtitle',
    'kwTargets',
    'mdPlatformApple',
    'mdPlatformGoogle',
  ]) {
    el(id)?.addEventListener('input', render);
  }
  // Screenshots has no per-keystroke signal to listen for (files, not text
  // inputs), so re-read it whenever Readiness's own tab becomes the active
  // one instead — Prepare's tabs are plain buttons switched by
  // views/launch.js, not a route, so this listens for the click directly
  // rather than a hash change that no longer happens for this tab.
  document.querySelector('.tab[data-tab="readiness"]')?.addEventListener('click', render);
  render();
}

function metadataValues() {
  return Object.fromEntries(Object.entries(METADATA_INPUTS).map(([k, id]) => [k, el(id).value]));
}

function render() {
  const shots = screenshotSummary();

  const metaValues = metadataValues();
  const hasMeta = Object.values(metaValues).some(Boolean);
  const metadata = hasMeta ? validateListing(metaValues, { stores: getSelectedStores() }) : null;

  // The keyword field and title/subtitle typed on Listing text win, since
  // that's the field a submission actually ships with; the dedicated
  // Keyword field page is the fallback for someone auditing a field before
  // it's ever gone into a listing at all.
  const field = el('mdKeywords').value || el('kwField').value;
  const targets = lines(el('kwTargets'));
  const hasKeywords = Boolean(field) || targets.length > 0;
  const keywords = hasKeywords
    ? auditField(field, {
        title: el('mdTitle').value || el('kwTitle').value,
        subtitle: el('mdSubtitle').value || el('kwSubtitle').value,
        targets,
      })
    : null;

  const sections = [
    {
      name: 'Screenshots',
      done: Boolean(shots),
      errorCount: shots?.errorCount ?? 0,
      warningCount: shots?.warningCount ?? 0,
      hint: 'Drop screenshots on the Screenshots page.',
    },
    {
      name: 'Listing text',
      done: Boolean(metadata),
      errorCount: metadata?.errorCount ?? 0,
      warningCount: metadata?.warningCount ?? 0,
      hint: 'Fill in fields on the Listing text page.',
    },
    {
      name: 'Keyword field',
      done: Boolean(keywords),
      errorCount: keywords?.findings.filter((f) => f.severity === 'error').length ?? 0,
      warningCount: keywords?.findings.filter((f) => f.severity === 'warning').length ?? 0,
      hint: 'Fill in the keyword field on the Keyword field page.',
    },
  ];

  const checked = sections.filter((s) => s.done);

  if (!checked.length) {
    el('rdSummary').innerHTML = '';
    el('rdChecklist').innerHTML = empty(
      '☑',
      'Nothing to check yet',
      "Fill in Screenshots, Listing text or the Keyword field — this page combines whatever you've entered, live.",
    );
    el('rdFindings').innerHTML = '';
    return;
  }

  const totalErrors = checked.reduce((a, s) => a + s.errorCount, 0);
  const totalWarnings = checked.reduce((a, s) => a + s.warningCount, 0);
  const cleanChecks = checked.filter((s) => s.errorCount === 0).length;
  const score = Math.round((100 * cleanChecks) / checked.length);
  const status = totalErrors ? 'fail' : totalWarnings ? 'warn' : 'pass';
  const verdict = totalErrors ? 'Not ready to submit' : totalWarnings ? 'Ready, with warnings' : 'Ready to submit';

  el('rdSummary').innerHTML = `
    <div class="summary ${status}">
      ${ring(score, { label: `${score} out of 100` })}
      <span class="verdict">${verdict}</span>
      <span class="muted">${checked.length} of 3 checks run · ${totalErrors} error(s) · ${totalWarnings} warning(s)</span>
    </div>`;

  el('rdChecklist').innerHTML = tablePanel({
    title: 'Checklist',
    sub: `${cleanChecks} of ${checked.length} run checks are clean`,
    head: ['', 'Check', { label: 'Result', num: true }],
    rows: sections.map((s) => [
      {
        html: !s.done
          ? '<span class="check-mark unknown">?</span>'
          : s.errorCount
            ? '<span class="check-mark bad">✕</span>'
            : '<span class="check-mark ok">✓</span>',
        tight: true,
      },
      {
        html: `<strong${s.done ? '' : ' class="muted"'}>${s.name}</strong>${
          !s.done ? `<br><span class="muted" style="font-size:.8rem">${s.hint}</span>` : ''
        }`,
      },
      {
        html: !s.done
          ? pill('not checked', 'neutral')
          : s.errorCount
            ? pill(`${s.errorCount} error(s)`, 'bad')
            : s.warningCount
              ? pill(`${s.warningCount} warning(s)`, 'warn')
              : pill('clean', 'ok'),
        num: true,
      },
    ]),
  });

  const allFindings = [...(metadata?.findings ?? []), ...(keywords?.findings ?? [])];
  el('rdFindings').innerHTML = findingsPanel(allFindings, 'Findings');
}
