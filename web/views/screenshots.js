/** Screenshot validation and repair. */

import { readFacts, UnreadableImageError } from '../lib/image-facts.js';
import { detectTargetStore, statusOf, validateFacts, validateSet } from '../lib/validator.js';
import { applyFix, planFix } from '../lib/fixer.js';
import { createZip, safeName, uniqueNames } from '../lib/zip.js';
import { el, escapeHtml, findingHtml, findingsPanel, pill } from './shared.js';

let entries = [];
let activeStore = 'apple';
let lastTargetStore = null;
let specLookup = null;
let nextId = 1;
/** Set while a thumbnail drag is in progress — `entries` reorders live as
 * the pointer crosses other thumbnails, so this is the id being carried,
 * not a position (positions shift under it as it moves). */
let draggingId = null;

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
  fileInput.addEventListener('change', (e) => {
    ingest([...e.target.files]);
    fileInput.value = ''; // so picking the same file again still fires 'change'
  });

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

  el('addShotsBtn').addEventListener('click', () => fileInput.click());
  el('storeSelect').addEventListener('change', render);
  el('targetSelect').addEventListener('change', render);
  el('bgInput').addEventListener('change', render);
  el('clearBtn').addEventListener('click', () => {
    for (const entry of entries) URL.revokeObjectURL(entry.thumbUrl);
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
      const id = nextId++;
      const thumbUrl = URL.createObjectURL(file);
      try {
        return { id, file, thumbUrl, facts: await readFacts(file), error: null };
      } catch (err) {
        return {
          id,
          file,
          thumbUrl,
          facts: null,
          error: err instanceof UnreadableImageError ? err.message : String(err),
        };
      }
    }),
  );
  entries = [...entries, ...added];
  render();
}

function removeEntry(id) {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;
  URL.revokeObjectURL(entry.thumbUrl);
  entries = entries.filter((e) => e.id !== id);
  render();
}

function render() {
  el('drop').classList.toggle('hidden', entries.length > 0);
  el('shotWall').classList.toggle('hidden', entries.length === 0);
  el('shotActions').classList.toggle('hidden', entries.length === 0);

  if (!entries.length) {
    el('shotWall').innerHTML = '';
    el('summary').innerHTML = '';
    el('setFindings').innerHTML = '';
    el('results').innerHTML = '';
    setFixButton(false, 'Drop screenshots with a fixable issue first');
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
      ? { id: entry.id, file: entry.file, thumbUrl: entry.thumbUrl, ...validateFacts(entry.facts, [activeStore]) }
      : {
          id: entry.id,
          file: entry.file,
          thumbUrl: entry.thumbUrl,
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
  renderWall(assets);
  renderAssets(assets);

  const fixable = assets.some((a) => a.facts && a.findings.some((f) => f.fixable));
  setFixButton(fixable, fixable ? '' : 'Nothing here needs fixing');
  el('fixNote').classList.toggle('hidden', !fixable);
}

/** Always visible, greyed out rather than hidden when there is nothing to
 * click it for — a button that vanishes the moment it would do something
 * reads as broken; a disabled one reads as "not yet". */
function setFixButton(enabled, title) {
  const button = el('fixBtn');
  button.disabled = !enabled;
  button.title = title;
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

/**
 * The draggable thumbnail grid. Reordering uses native HTML5 drag-and-drop
 * to track *which* two thumbnails swapped, but the sliding itself is a
 * small FLIP animation (capture positions before the DOM changes, let the
 * browser lay out the new order, then animate from old position to new) —
 * native drag-and-drop alone only gives you a static drop, not a slide.
 */
function renderWall(assets) {
  const wall = el('shotWall');
  const before = new Map([...wall.children].map((c) => [c.dataset.id, c.getBoundingClientRect()]));

  wall.innerHTML = assets
    .map(
      (a, i) => `
      <div class="shot-thumb" draggable="true" data-id="${a.id}">
        <span class="shot-index">${i + 1}</span>
        <span class="shot-status ${STATUS_TONE[a.status] ?? ''}" title="${escapeHtml(a.status)}"></span>
        <button type="button" class="shot-remove" data-id="${a.id}" title="Remove" aria-label="Remove ${escapeHtml(a.file.name)}">×</button>
        <img src="${a.thumbUrl}" alt="">
        <span class="shot-name">${escapeHtml(a.file.name)}</span>
      </div>`,
    )
    .join('');

  for (const thumb of wall.children) {
    const prev = before.get(thumb.dataset.id);
    if (!prev) continue;
    const now = thumb.getBoundingClientRect();
    const dx = prev.left - now.left;
    const dy = prev.top - now.top;
    if (!dx && !dy) continue;
    thumb.style.transition = 'none';
    thumb.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(() => {
      thumb.style.transition = 'transform .2s ease';
      thumb.style.transform = '';
    });
  }

  wall.querySelectorAll('.shot-thumb').forEach((thumb) => {
    const id = Number(thumb.dataset.id);

    thumb.addEventListener('dragstart', (e) => {
      draggingId = id;
      e.dataTransfer.effectAllowed = 'move';
      // Firefox refuses to start a drag without data set on it.
      e.dataTransfer.setData('text/plain', String(id));
      requestAnimationFrame(() => thumb.classList.add('dragging'));
    });
    thumb.addEventListener('dragend', () => {
      draggingId = null;
      thumb.classList.remove('dragging');
      wall.querySelectorAll('.drag-over').forEach((n) => n.classList.remove('drag-over'));
    });
    thumb.addEventListener('dragenter', (e) => {
      e.preventDefault();
      if (id !== draggingId) thumb.classList.add('drag-over');
    });
    thumb.addEventListener('dragleave', () => thumb.classList.remove('drag-over'));
    thumb.addEventListener('dragover', (e) => e.preventDefault());
    thumb.addEventListener('drop', (e) => {
      e.preventDefault();
      thumb.classList.remove('drag-over');
      if (draggingId === null || draggingId === id) return;
      const from = entries.findIndex((entry) => entry.id === draggingId);
      const to = entries.findIndex((entry) => entry.id === id);
      if (from === -1 || to === -1) return;
      const [moved] = entries.splice(from, 1);
      entries.splice(to, 0, moved);
      render();
    });

    thumb.querySelector('.shot-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeEntry(id);
    });
  });
}

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
        : [createZip(items), 'appmates-fixed.zip'];
    download(blob, filename);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

/**
 * The current upload's verdict, for the Readiness view to fold in — same
 * counting `render()` does, kept separate rather than shared so a change to
 * this page's own rendering can't accidentally change what Readiness reads.
 * Returns `null` when nothing has been dropped yet, never a zero-findings
 * report standing in for "not checked".
 */
export function screenshotSummary() {
  if (!entries.length) return null;

  const readable = entries.filter((e) => e.facts);
  const choice = el('storeSelect').value;
  const store = choice === 'auto' ? detectTargetStore(readable.map((e) => e.facts)) : choice;

  const assets = entries.map((entry) =>
    entry.facts
      ? { ...validateFacts(entry.facts, [store]) }
      : {
          facts: null,
          findings: [{ code: 'UNREADABLE_IMAGE', severity: 'error', message: entry.error ?? 'Cannot read image' }],
        },
  );
  const setFindings = validateSet(
    assets.filter((a) => a.facts),
    [store],
  );
  const allFindings = [...setFindings, ...assets.flatMap((a) => a.findings)];

  return {
    count: entries.length,
    store,
    status: statusOf(allFindings),
    errorCount: allFindings.filter((f) => f.severity === 'error').length,
    warningCount: allFindings.filter((f) => f.severity === 'warning').length,
  };
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
