/**
 * The "which store" pill — `ios`/`android`/`both` rendered as a solid badge.
 * Shared so any future spot needing it (the leaderboard used to, briefly)
 * reads the same colours and labels as the browse table, where it started.
 */

export const PLATFORM_LABEL = { ios: 'iOS', android: 'Android', both: 'Both' };

export function platformBadge(platform) {
  const label = PLATFORM_LABEL[platform];
  if (!label) return '';
  return `<span class="pf-badge ${platform}">${label}</span>`;
}
