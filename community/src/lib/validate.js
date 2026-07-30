export function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** A request-to-test message, trimmed and length-checked against `[min, max]`.
 * Whitespace-only input fails `min` the same as empty — trimming first means
 * a message of spaces can't slip past a naive `.length` check. */
export function isValidMessage(value, { min, max }) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length >= min && trimmed.length <= max;
}
