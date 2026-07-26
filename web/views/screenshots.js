/** Screenshot validation and repair. */

import { readFacts, UnreadableImageError } from '../lib/image-facts.js';
import { detectTargetStore, statusOf, validateFacts, validateSet } from '../lib/validator.js';
import { applyFix, planFix } from '../lib/fixer.js';
import { createZip, safeName, uniqueNames } from '../lib/zip.js';
import { appIcon, el, empty, escapeHtml, findingHtml, findingsPanel, pill } from './shared.js';

let entries = [];
let activeStore = 'apple';
let lastTargetStore = null;
let specLookup = null;

export function initScreenshots({ getSpec }) {
  specLookup = getSpec;

  const drop = el('drop');
  const fileInput = el('fileInput');

  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', (e) => ingest([...e.target.files]));

  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.classList.add('dragging');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.classList.remove('dragging');
    });
  }
  drop.addEventListener('drop', (e) =>
    ingest([...(e.dataTransfer?.files ?? [])].filter((f) => /\.(png|jpe?g)$/i.test(f.name))),
  );

  el('storeSelect').addEventListener('change', render);
  el('targetSelect').addEventListener('change', render);
  el('bgInput').addEventListener('change', render);
  el('clearBtn').addEventListener('click', () => {
    entries = [];
    render();
  });
  el('fixBtn').addEventListener('click', runFix);

  populateTargets('apple');
}

function populateTargets(store) {
  const options = specLookup(store)
    .sizes.filter((s) => s.status === 'required' || s.status === 'accepted')
    .map((s) => `<option value="${s.id}">${s.device_class} — ${s.width}×${s.height}</option>`)
    .join('');
  el('targetSelect').innerHTML = `<option value="">Nearest valid size</option>${options}`;
}

async function ingest(files) {
  if (!files.length) return;
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

function render() {
  el('clearBtn').classList.toggle('hidden', entries.length === 0);

  if (!entries.length) {
    el('summary').innerHTML = '';
    el('setFindings').innerHTML = '';
    el('results').innerHTML = '';
    el('fixBtn').classList.add('hidden');
    el('fixNote').classList.add('hidden');
    return;
  }

  const readable = entries.filter((e) => e.facts);
  const choice = el('storeSelect').value;
  activeStore = choice === 'auto' ? detectTargetStore(readable.map((e) => e.facts)) : choice;
  if (activeStore !== lastTargetStore) {
    lastTargetStore = activeStore;
    populateTargets(activeStore);
  }

  const assets = entries.map((entry) =>
    entry.facts
      ? { file: entry.file, ...validateFacts(entry.facts, [activeStore]) }
      : {
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
        },
  );

  const setFindings = validateSet(
    assets.filter((a) => a.facts),
    [activeStore],
  );

  renderSummary(assets, setFindings, choice === 'auto');
  el('setFindings').innerHTML = findingsPanel(setFindings, 'Across the whole set');
  renderAssets(assets);

  const fixable = assets.some((a) => a.facts && a.findings.some((f) => f.fixable));
  el('fixBtn').classList.toggle('hidden', !fixable);
  el('fixNote').classList.toggle('hidden', !fixable);
}

function renderSummary(assets, setFindings, wasAuto) {
  const all = [...setFindings, ...assets.flatMap((a) => a.findings)];
  const errors = all.filter((f) => f.severity === 'error').length;
  const warnings = all.filter((f) => f.severity === 'warning').length;
  const status = statusOf(all);
  const storeName = activeStore === 'apple' ? 'App Store' : 'Google Play';
  const verdict =
    status === 'pass'
      ? 'Ready to upload'
      : status === 'warn'
        ? 'Uploadable, with warnings'
        : 'Will be rejected';

  el('summary').innerHTML = `
    <div class="summary ${status}">
      <span class="verdict">${verdict}</span>
      <span class="muted">${assets.length} file${assets.length === 1 ? '' : 's'} ·
        <strong>${storeName}</strong>${wasAuto ? ' (auto-detected)' : ''}</span>
      <span style="margin-left:auto">
        ${errors ? pill(`${errors} error${errors === 1 ? '' : 's'}`, 'bad') : ''}
        ${warnings ? pill(`${warnings} warning${warnings === 1 ? '' : 's'}`, 'warn') : ''}
        ${!errors && !warnings ? pill('clean', 'ok') : ''}
      </span>
    </div>`;
}

const STATUS_TONE = { pass: 'ok', warn: 'warn', fail: 'bad' };

function renderAssets(assets) {
  el('results').innerHTML = assets
    .map((a) => {
      const f = a.facts;
      const meta = f
        ? `${f.width}×${f.height} · ${f.mode}/${f.imageFormat} · ${(f.sizeBytes / 1048576).toFixed(1)} MB` +
          (a.deviceClass ? ` · ${a.deviceClass}` : '')
        : 'unreadable';
      return `
        <div class="panel">
          <div class="panel-head">
            ${pill(a.status, STATUS_TONE[a.status])}
            <span>${escapeHtml(a.file.name)}</span>
            <span class="sub mono" style="margin-left:auto">${escapeHtml(meta)}</span>
          </div>
          ${a.findings.length ? `<div class="findings">${a.findings.map(findingHtml).join('')}</div>` : ''}
        </div>`;
    })
    .join('');
}

async function runFix() {
  const button = el('fixBtn');
  const spec = specLookup(activeStore);
  const background = el('bgInput').value;
  const explicitTargetId = el('targetSelect').value || null;
  const originalLabel = button.textContent;

  button.disabled = true;
  try {
    const fixed = [];
    for (const entry of entries) {
      if (!entry.facts) continue;
      button.textContent = `Fixing ${fixed.length + 1}/${entries.length}…`;
      const plan = planFix(spec, entry.facts, { explicitTargetId, background });
      const result = await applyFix(entry.file, entry.facts, plan, { background });
      fixed.push({
        name: safeName(result.name),
        data: new Uint8Array(await result.blob.arrayBuffer()),
      });
    }
    if (!fixed.length) return;

    const names = uniqueNames(fixed.map((f) => f.name));
    const items = fixed.map((f, i) => ({ ...f, name: names[i] }));

    // A single file downloads directly; a batch would hit the browser's
    // multiple-download throttle, so it goes out as one archive.
    const [blob, filename] =
      items.length === 1
        ? [new Blob([items[0].data], { type: 'image/jpeg' }), items[0].name]
        : [createZip(items), 'launchpilot-fixed.zip'];
    download(blob, filename);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

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
