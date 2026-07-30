import { MIN_RESOLVED_FOR_RELIABILITY } from './config.js';

/**
 * A builder's reliability, derived from counts already computed in SQL
 * (see `LISTING_SELECT` in routes/listings.js). Kept as a pure function so
 * the "not enough history yet" rule is unit-testable without a database.
 *
 * `resolvedCount` is every session that reached a final state either way
 * (`completed`, `declined`, or `abandoned`) — declines count against
 * nobody's rate by omission, they count *in* the denominator, because
 * ignoring them would let a builder who never responds look flawless.
 */
export function builderReliability({ completedCount, resolvedCount, avgResponseHours }) {
  if (resolvedCount < MIN_RESOLVED_FOR_RELIABILITY) {
    return { isNew: true, completionRate: null, avgResponseHours: null, resolvedCount };
  }
  return {
    isNew: false,
    completionRate: Math.round((completedCount / resolvedCount) * 100),
    avgResponseHours: avgResponseHours == null ? null : Math.round(avgResponseHours * 10) / 10,
    resolvedCount,
  };
}

/** A tester's public identity on the leaderboard — never the raw email,
 * even when they haven't picked a display name yet. */
export function publicDisplayName({ displayName, id }) {
  const trimmed = displayName?.trim();
  return trimmed || `Tester ${id.slice(0, 6)}`;
}
