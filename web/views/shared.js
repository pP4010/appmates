/**
 * Rendering primitives shared by every view.
 *
 * Nothing here knows a rule. Engines return numbers and codes; these turn them
 * into something scannable.
 */

export function el(id) {
  return document.getElementById(id);
}

/** Which test-session statuses have anything to coordinate. Only once a
 * request has been accepted is there something to arrange — a device the
 * tester doesn't have, a build that needs a fresh TestFlight invite. Before
 * that the pitch (`requestMessage`) already says everything there is to
 * say, and after `declined`/`abandoned` there's nothing left to arrange, so
 * neither status gets a thread. Shared between `community.js` (inline
 * per-session threads) and `inbox.js` (the dedicated conversation list),
 * so the two can never drift on what counts as a conversation. */
export const MESSAGEABLE_STATUSES = new Set(['accepted', 'submitted', 'completed']);

/** Picked cause on a conversation report, kept in sync by hand with
 * `REPORT_CAUSES` in community/src/lib/config.js — the server validates
 * against that array, not against these labels, so a mismatch here would
 * just show the wrong words for a real value rather than break anything.
 * Shared between `inbox.js` (the report dialog) and `admin.js` (the
 * reports queue), so both always show the same label for the same cause. */
export const REPORT_CAUSE_LABELS = {
  fraud: 'Suspected fraud or fake test',
  abuse: 'Abusive or inappropriate messages',
  spam: 'Spam or unrelated content',
  sensitive: 'Sharing sensitive information',
  other: 'Other',
};

export function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

/** Score band, shared by rings, pills and bars so one value never reads two ways. */
export function toneFor(score, [good, fair] = [65, 35]) {
  return score >= good ? 'ok' : score >= fair ? 'warn' : 'bad';
}

/**
 * A score as a dial.
 *
 * Six signals drawn as stacked horizontal bars read like a progress list — as
 * though something were loading. A ring reads as a reading: comparable across a
 * table at a glance, without needing the rows to line up.
 */
export function ring(value, { size = 34, stroke = 3.5, thresholds, label } = {}) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, value));
  const offset = circumference * (1 - clamped / 100);
  const tone = toneFor(value, thresholds);
  const mid = size / 2;

  return `<svg class="ring ${tone}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"
      role="img" aria-label="${escapeHtml(label ?? `${Math.round(value)} out of 100`)}">
    <circle class="track" cx="${mid}" cy="${mid}" r="${radius}" fill="none" stroke-width="${stroke}"/>
    <circle class="fill" cx="${mid}" cy="${mid}" r="${radius}" fill="none" stroke-width="${stroke}"
      stroke-linecap="round" stroke-dasharray="${circumference.toFixed(2)}"
      stroke-dashoffset="${offset.toFixed(2)}"
      transform="rotate(-90 ${mid} ${mid})"/>
    <text class="label" x="${mid}" y="${mid}" text-anchor="middle" dominant-baseline="central"
      >${Math.round(value)}</text>
  </svg>`;
}

export function pill(text, tone = 'neutral') {
  return `<span class="pill ${tone}">${escapeHtml(text)}</span>`;
}

/**
 * A two-letter storefront code as its flag emoji — the well-known trick of
 * mapping each ASCII letter to its Unicode regional-indicator symbol, so
 * "us" becomes 🇺🇸 with no image asset or lookup table to keep current as
 * storefronts get added. Renders as plain letters on the rare platform
 * with no flag glyphs, which degrades to exactly what was shown before
 * this existed rather than to nothing.
 */
export function flagEmoji(countryCode) {
  const code = (countryCode || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return '';
  return [...code].map((c) => String.fromCodePoint(127397 + c.charCodeAt(0))).join('');
}

/** Movement between two positions. Positive is upward, which is fewer places. */
export function delta(value) {
  if (value === null || value === undefined) return '<span class="delta flat">—</span>';
  if (value > 0) return `<span class="delta up">▲ ${value}</span>`;
  if (value < 0) return `<span class="delta down">▼ ${Math.abs(value)}</span>`;
  return '<span class="delta flat">=</span>';
}

export function bar(percent, tone) {
  const width = Math.max(0, Math.min(100, percent));
  return `<span class="bar ${tone}"><span style="width:${width}%"></span></span>`;
}

export function appIcon(url, alt = '') {
  return url
    ? `<img class="app-icon" src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy">`
    : '<span class="app-icon"></span>';
}

/** Same slot as `appIcon`, but falls back to a coloured initial instead of
 * an empty box when there's no image — for the Inbox, where the icon
 * often stands in for a *person* on the other end of a conversation, not
 * just an app that legitimately has no artwork yet. */
export function iconOrInitial(url, name) {
  if (url) return appIcon(url, name);
  const letter = (name || '').trim().charAt(0).toUpperCase() || '?';
  return `<span class="app-icon letter-avatar">${escapeHtml(letter)}</span>`;
}

/** Overlapping icon row, for showing a field of apps in one cell. */
export function iconStack(urls, limit = 5) {
  if (!urls?.length) return '';
  return `<span class="icon-stack">${urls
    .slice(0, limit)
    .map((u) => `<img src="${escapeHtml(u)}" alt="" loading="lazy">`)
    .join('')}</span>`;
}

const MARKS = { error: '✕', warning: '!', info: 'i' };

export function findingHtml(finding) {
  const severity = finding.severity ?? 'info';
  const cost = finding.metadata?.cost;
  return `
    <div class="finding ${severity}">
      <span class="finding-mark">${MARKS[severity] ?? 'i'}</span>
      <span class="finding-body">
        <span class="finding-code">${escapeHtml(finding.code)}</span>
        <span class="finding-msg">${escapeHtml(finding.message)}</span>
        ${finding.fixHint ? `<span class="finding-hint">${escapeHtml(finding.fixHint)}</span>` : ''}
      </span>
      ${cost ? `<span class="finding-cost">−${cost}c</span>` : ''}
    </div>`;
}

export function findingsPanel(findings, title) {
  if (!findings.length) return '';
  return `<div class="panel">
    ${title ? `<div class="panel-head">${escapeHtml(title)}</div>` : ''}
    <div class="findings">${findings.map(findingHtml).join('')}</div>
  </div>`;
}

export function notesHtml(notes) {
  if (!notes?.length) return '';
  return notes.map((n) => `<p class="note">${escapeHtml(n)}</p>`).join('');
}

export function empty(icon, title, hint) {
  return `<div class="empty">
    <span class="empty-icon">${icon}</span>
    <strong>${escapeHtml(title)}</strong>
    <span>${escapeHtml(hint)}</span>
  </div>`;
}

/** A push arrived while a tab had focus — see `push-sw.js` and
 * `lib/push.js`'s `listenForInAppToasts`. Auto-dismisses; clicking it runs
 * `onClick` (typically a hash change into the relevant thread) and closes
 * it early. */
export function showToast({ title, body, onClick }) {
  const toast = document.createElement('button');
  toast.type = 'button';
  toast.className = 'toast';
  toast.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(body)}</span>`;
  toast.addEventListener('click', () => {
    onClick?.();
    toast.remove();
  });
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 7000);
  return toast;
}

export function skeleton(rows = 5) {
  return Array.from({ length: rows }, () => '<div class="skeleton-row"></div>').join('');
}

export function lines(textarea) {
  return textarea.value
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * A panel containing a table.
 *
 * Cells are either a plain value (escaped) or `{ html, num }` when they carry
 * markup or should align right.
 */
export function tablePanel({ title, sub, head, rows, empty: emptyState }) {
  if (!rows.length && emptyState) return emptyState;

  const headHtml = head
    .map((h) => `<th class="${h.num ? 'num' : ''} ${h.center ? 'center' : ''}">${escapeHtml(h.label ?? h)}</th>`)
    .join('');
  const bodyHtml = rows
    .map(
      (row) =>
        `<tr>${row
          .map(
            (cell) =>
              `<td class="${cell?.num ? 'num' : ''} ${cell?.center ? 'center' : ''} ${cell?.tight ? 'tight' : ''}">${
                cell?.html ?? escapeHtml(cell)
              }</td>`,
          )
          .join('')}</tr>`,
    )
    .join('');

  return `<div class="panel">
    ${
      title
        ? `<div class="panel-head">${escapeHtml(title)}${sub ? `<span class="sub">${escapeHtml(sub)}</span>` : ''}</div>`
        : ''
    }
    <div class="table-wrap"><table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>
  </div>`;
}

/**
 * Run an async job with a status line, a skeleton and a disabled button.
 *
 * Every network view needs the same three things: say what is happening, never
 * leave a dead button, and turn a thrown error into a sentence.
 */
export async function withStatus(statusEl, button, resultsEl, job) {
  const label = button?.textContent;
  if (button) button.disabled = true;
  statusEl.className = 'status';
  statusEl.innerHTML = '<span class="spinner"></span> Working…';
  if (resultsEl) resultsEl.innerHTML = skeleton(6);

  try {
    const result = await job((message) => {
      statusEl.innerHTML = `<span class="spinner"></span> ${escapeHtml(message)}`;
    });
    statusEl.innerHTML = '';
    return result;
  } catch (err) {
    statusEl.className = 'status error';
    statusEl.textContent = err.message;
    if (resultsEl) resultsEl.innerHTML = '';
    return null;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = label;
    }
  }
}
