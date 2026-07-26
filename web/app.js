/**
 * UI wiring only. Every rule lives in lib/validator.js, every fix in lib/fixer.js,
 * mirroring the CLI's split between commands and core services.
 */

import { readFacts, UnreadableImageError } from './lib/image-facts.js';
import {
  detectTargetStore,
  getSpec,
  loadSpecs,
  statusOf,
  validateFacts,
  validateSet,
} from './lib/validator.js';
import { applyFix, planFix } from './lib/fixer.js';
import { createZip, safeName, uniqueNames } from './lib/zip.js';
import { auditField, loadAso } from './lib/keywords.js';

const els = {
  drop: document.getElementById('drop'),
  fileInput: document.getElementById('fileInput'),
  storeSelect: document.getElementById('storeSelect'),
  targetSelect: document.getElementById('targetSelect'),
  bgInput: document.getElementById('bgInput'),
  clearBtn: document.getElementById('clearBtn'),
  summary: document.getElementById('summary'),
  setFindings: document.getElementById('setFindings'),
  results: document.getElementById('results'),
  fixPanel: document.getElementById('fixPanel'),
  fixBtn: document.getElementById('fixBtn'),
  provenance: document.getElementById('provenance'),
};

/** @type {{file: File, facts: object|null, error: string|null}[]} */
let entries = [];
let activeStore = 'apple';
let specsData = null;

// --- boot ----------------------------------------------------------------

async function boot() {
  const response = await fetch('./lib/specs.json');
  specsData = await response.json();
  loadSpecs(specsData);
  loadAso(specsData);

  const apple = specsData.stores.apple;
  const google = specsData.stores.google;
  els.provenance.textContent =
    `Specifications verified ${apple.last_verified} (App Store) and ` +
    `${google.last_verified} (Google Play) against the official documentation.`;

  populateTargets('apple');
}

function populateTargets(store) {
  const spec = getSpec(store);
  const options = spec.sizes
    .filter((s) => s.status === 'required' || s.status === 'accepted')
    .map((s) => `<option value="${s.id}">${s.device_class} — ${s.width}×${s.height}</option>`)
    .join('');
  els.targetSelect.innerHTML = `<option value="">Nearest valid size</option>${options}`;
}

// --- input ---------------------------------------------------------------

els.drop.addEventListener('click', () => els.fileInput.click());
els.drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    els.fileInput.click();
  }
});
els.fileInput.addEventListener('change', (e) => ingest([...e.target.files]));

for (const type of ['dragenter', 'dragover']) {
  els.drop.addEventListener(type, (e) => {
    e.preventDefault();
    els.drop.classList.add('dragging');
  });
}
for (const type of ['dragleave', 'drop']) {
  els.drop.addEventListener(type, (e) => {
    e.preventDefault();
    els.drop.classList.remove('dragging');
  });
}
els.drop.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files ?? [])].filter((f) =>
    /\.(png|jpe?g)$/i.test(f.name),
  );
  ingest(files);
});

els.storeSelect.addEventListener('change', render);
els.targetSelect.addEventListener('change', render);
els.bgInput.addEventListener('change', render);
els.clearBtn.addEventListener('click', () => {
  entries = [];
  render();
});

async function ingest(files) {
  if (files.length === 0) return;

  const added = await Promise.all(
    files.map(async (file) => {
      try {
        return { file, facts: await readFacts(file), error: null };
      } catch (err) {
        return {
          file,
          facts: null,
          error: err instanceof UnreadableImageError ? err.message : String(err),
        };
      }
    }),
  );

  entries = [...entries, ...added];
  render();
}

// --- rendering -----------------------------------------------------------

function render() {
  els.clearBtn.classList.toggle('hidden', entries.length === 0);

  if (entries.length === 0) {
    els.summary.style.display = 'none';
    els.setFindings.innerHTML = '';
    els.results.innerHTML = '';
    els.fixPanel.style.display = 'none';
    return;
  }

  const readable = entries.filter((e) => e.facts);
  const choice = els.storeSelect.value;
  activeStore =
    choice === 'auto' ? detectTargetStore(readable.map((e) => e.facts)) : choice;
  populateTargetsIfStoreChanged(activeStore);

  const assets = entries.map((entry) => {
    if (!entry.facts) {
      return {
        file: entry.file,
        facts: null,
        status: 'fail',
        deviceClass: null,
        findings: [
          {
            code: 'UNREADABLE_IMAGE',
            severity: 'error',
            message: entry.error ?? 'Cannot read image',
            fixHint: 'Re-export the file; it may be truncated or not an image.',
          },
        ],
      };
    }
    return { file: entry.file, ...validateFacts(entry.facts, [activeStore]) };
  });

  const setFindings = validateSet(assets.filter((a) => a.facts), [activeStore]);

  renderSummary(assets, setFindings, choice === 'auto');
  renderSetFindings(setFindings);
  renderAssets(assets);

  const fixable = assets.some((a) => a.facts && a.findings.some((f) => f.fixable));
  els.fixPanel.style.display = fixable ? 'block' : 'none';
}

let lastTargetStore = null;
function populateTargetsIfStoreChanged(store) {
  if (store !== lastTargetStore) {
    lastTargetStore = store;
    populateTargets(store);
  }
}

function counts(findings) {
  return {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
  };
}

function renderSummary(assets, setFindings, wasAuto) {
  const all = [...setFindings, ...assets.flatMap((a) => a.findings)];
  const { errors, warnings } = counts(all);
  const status = statusOf(all);
  const storeName = activeStore === 'apple' ? 'App Store' : 'Google Play';

  const verdict =
    status === 'pass'
      ? 'Ready to upload'
      : status === 'warn'
        ? 'Uploadable, with warnings'
        : 'Will be rejected';

  els.summary.className = status;
  els.summary.style.display = 'block';
  els.summary.innerHTML = `
    <span class="verdict">${verdict}</span>
    <span class="detail">
      · ${assets.length} file${assets.length === 1 ? '' : 's'} checked against
      <strong>${storeName}</strong>${wasAuto ? ' (auto-detected)' : ''}
      · ${errors} error${errors === 1 ? '' : 's'}
      · ${warnings} warning${warnings === 1 ? '' : 's'}
    </span>`;
}

function findingHtml(f) {
  return `
    <div class="finding ${f.severity}">
      <span class="code">${f.code}</span>
      <span class="msg">${escapeHtml(f.message)}</span>
      ${f.fixHint ? `<div class="hint">→ ${escapeHtml(f.fixHint)}</div>` : ''}
    </div>`;
}

function renderSetFindings(findings) {
  if (findings.length === 0) {
    els.setFindings.innerHTML = '';
    return;
  }
  els.setFindings.innerHTML = `
    <h2>Across the whole set</h2>
    <div class="card"><div class="findings">${findings.map(findingHtml).join('')}</div></div>`;
}

function renderAssets(assets) {
  els.results.innerHTML =
    `<h2>Files</h2>` +
    assets
      .map((a) => {
        const f = a.facts;
        const meta = f
          ? `${f.width}×${f.height} · ${f.mode}/${f.imageFormat} · ${(f.sizeBytes / 1048576).toFixed(1)} MB` +
            (a.deviceClass ? ` · ${a.deviceClass}` : '')
          : 'unreadable';
        return `
          <div class="card">
            <div class="card-head">
              <span class="badge ${a.status}">${a.status}</span>
              <span class="name">${escapeHtml(a.file.name)}</span>
              <span class="meta mono">${escapeHtml(meta)}</span>
            </div>
            ${
              a.findings.length
                ? `<div class="findings">${a.findings.map(findingHtml).join('')}</div>`
                : ''
            }
          </div>`;
      })
      .join('');
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

// --- repair --------------------------------------------------------------

els.fixBtn.addEventListener('click', async () => {
  const spec = getSpec(activeStore);
  const background = els.bgInput.value;
  const explicitTargetId = els.targetSelect.value || null;

  els.fixBtn.disabled = true;
  const originalLabel = els.fixBtn.textContent;

  try {
    const fixed = [];
    for (const entry of entries) {
      if (!entry.facts) continue;

      els.fixBtn.textContent = `Fixing ${fixed.length + 1}/${entries.length}…`;
      const plan = planFix(spec, entry.facts, { explicitTargetId, background });
      const result = await applyFix(entry.file, entry.facts, plan, { background });
      fixed.push({
        name: safeName(result.name),
        data: new Uint8Array(await result.blob.arrayBuffer()),
      });
    }

    if (fixed.length === 0) return;

    // A single file downloads directly; a batch would otherwise hit the
    // browser's multiple-download throttle, so it goes out as one archive.
    const names = uniqueNames(fixed.map((f) => f.name));
    const entries = fixed.map((f, i) => ({ ...f, name: names[i] }));

    const [blob, filename] =
      entries.length === 1
        ? [new Blob([entries[0].data], { type: 'image/jpeg' }), entries[0].name]
        : [createZip(entries), 'launchpilot-fixed.zip'];

    download(blob, filename);
  } finally {
    els.fixBtn.disabled = false;
    els.fixBtn.textContent = originalLabel;
  }
});

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

boot();

// --- tabs ----------------------------------------------------------------

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.tab')) {
      const selected = other === tab;
      other.classList.toggle('active', selected);
      other.setAttribute('aria-selected', String(selected));
      document.getElementById(other.dataset.panel).hidden = !selected;
    }
  });
}

// --- keyword field -------------------------------------------------------

const kw = {
  title: document.getElementById('kwTitle'),
  subtitle: document.getElementById('kwSubtitle'),
  field: document.getElementById('kwField'),
  targets: document.getElementById('kwTargets'),
  budget: document.getElementById('kwBudget'),
  findings: document.getElementById('kwFindings'),
  coverage: document.getElementById('kwCoverage'),
  suggestion: document.getElementById('kwSuggestion'),
};

function renderKeywords() {
  const targets = kw.targets.value
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean);

  const field = kw.field.value;
  if (!field && targets.length === 0) {
    for (const el of [kw.budget, kw.findings, kw.coverage, kw.suggestion]) el.innerHTML = '';
    return;
  }

  const report = auditField(field, {
    title: kw.title.value,
    subtitle: kw.subtitle.value,
    targets,
  });

  const width = 30;
  const filled = Math.round((width * Math.min(report.length, report.maxLength)) / report.maxLength);
  const over = report.length > report.maxLength;
  // Colour by waste, not by fill. A field sitting comfortably under 100
  // characters while throwing half of them away is not a green state, and a
  // green bar is exactly what stops someone reading the findings underneath.
  const tone = over ? 'over' : report.wastedCharacters ? 'warn' : 'ok';
  kw.budget.innerHTML = `
    <div class="budget-line">
      <span class="budget-bar ${tone}">${'█'.repeat(filled)}${'░'.repeat(width - filled)}</span>
      <span class="${over ? '' : 'muted'}"><strong>${report.length}</strong>/${report.maxLength} characters</span>
      ${
        report.wastedCharacters
          ? `<span style="color:var(--warning)">${report.wastedCharacters} wasted</span>`
          : '<span style="color:var(--success)">nothing wasted</span>'
      }
    </div>`;

  kw.findings.innerHTML = report.findings.length
    ? `<div class="card"><div class="findings">${report.findings
        .map(
          (f) => `
          <div class="finding ${f.severity}">
            <span class="code">${f.code}</span>
            ${f.metadata.cost ? `<span class="meta mono"> −${f.metadata.cost}c</span>` : ''}
            <span class="msg">${escapeHtml(f.message)}</span>
            ${f.fixHint ? `<div class="hint">→ ${escapeHtml(f.fixHint)}</div>` : ''}
          </div>`,
        )
        .join('')}</div></div>`
    : '';

  kw.coverage.innerHTML = report.coverage.length
    ? `<h2>Can you rank for these?</h2>
       <div class="card"><div class="findings">${report.coverage
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
    kw.suggestion.innerHTML = `
      <div class="suggestion">
        <strong>Suggested field</strong>
        <code>${escapeHtml(report.suggestedField)}</code>
        <span class="meta mono">${report.suggestedField.length}/${report.maxLength} characters${
          saved > 0 ? ` · ${saved} reclaimed` : ''
        }</span>
        <button id="kwCopy" style="margin-left:.75rem">Copy</button>
      </div>`;
    document.getElementById('kwCopy').addEventListener('click', async (e) => {
      await navigator.clipboard.writeText(report.suggestedField);
      e.target.textContent = 'Copied';
      setTimeout(() => (e.target.textContent = 'Copy'), 1500);
    });
  } else {
    kw.suggestion.innerHTML = '';
  }
}

for (const el of [kw.title, kw.subtitle, kw.field, kw.targets]) {
  el.addEventListener('input', renderKeywords);
}
