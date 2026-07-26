/** Rendering helpers shared by every view. */

export function el(id) {
  return document.getElementById(id);
}

export function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

export function meter(score, { width = 12, thresholds = [65, 35] } = {}) {
  const filled = Math.max(0, Math.min(width, Math.round((width * score) / 100)));
  const [good, fair] = thresholds;
  const tone = score >= good ? 'ok' : score >= fair ? 'warn' : 'bad';
  return `<span class="meter ${tone}">${'█'.repeat(filled)}${'░'.repeat(width - filled)}</span>`;
}

export function findingHtml(finding) {
  const cost = finding.metadata?.cost;
  return `
    <div class="finding ${finding.severity}">
      <span class="code">${escapeHtml(finding.code)}</span>
      ${cost ? `<span class="meta mono muted"> −${cost}c</span>` : ''}
      <span class="msg">${escapeHtml(finding.message)}</span>
      ${finding.fixHint ? `<div class="hint">→ ${escapeHtml(finding.fixHint)}</div>` : ''}
    </div>`;
}

export function findingsCard(findings) {
  if (!findings.length) return '';
  return `<div class="card"><div class="findings">${findings.map(findingHtml).join('')}</div></div>`;
}

export function notesHtml(notes) {
  if (!notes?.length) return '';
  return notes.map((n) => `<p class="note">${escapeHtml(n)}</p>`).join('');
}

export function lines(textarea) {
  return textarea.value
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Run an async job with a status line, disabling its button.
 *
 * Every network view needs the same thing: say what is happening, never leave a
 * dead button, and turn a thrown error into something a person can read.
 */
export async function withStatus(statusEl, button, job) {
  const label = button?.textContent;
  if (button) button.disabled = true;
  statusEl.className = 'status';
  statusEl.innerHTML = '<span class="spinner">◐</span> Working…';

  try {
    const result = await job((message) => {
      statusEl.innerHTML = `<span class="spinner">◐</span> ${escapeHtml(message)}`;
    });
    statusEl.innerHTML = '';
    return result;
  } catch (err) {
    statusEl.className = 'status error';
    statusEl.textContent = err.message;
    return null;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = label;
    }
  }
}

export function table({ head, rows, className = '' }) {
  const headHtml = head
    .map((h) => `<th class="${h.num ? 'num' : ''}">${escapeHtml(h.label ?? h)}</th>`)
    .join('');
  const bodyHtml = rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td class="${cell?.num ? 'num' : ''}">${cell?.html ?? escapeHtml(cell)}</td>`).join('')}</tr>`,
    )
    .join('');
  return `<div class="table-wrap ${className}"><table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`;
}

export function badge(text, tone) {
  return `<span class="badge ${tone}">${escapeHtml(text)}</span>`;
}
