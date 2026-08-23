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

/** The corner-icon badge: Apple/Google marks (or both, diagonally fanned),
 * originally built for the leaderboard's app-icon corner (`web/landing.js`)
 * and shared here so listing cards can reuse the exact same markup/CSS. See
 * `.store-badge` in styles.css for the base shape and `.store-badge.both`
 * (landing.css) for the diagonal-duo layout this depends on. `corner`
 * selects which corner CSS anchors it to — `'br'` (bottom-right, the
 * leaderboard's own placement) or `'bl'` (bottom-left, used on listing
 * cards) — via a modifier class, not inline positioning. */
export function storeBadgeHtml(platform, corner = 'br') {
  const cornerClass = corner === 'bl' ? ' bl' : '';
  if (platform === 'android') {
    return `<span class="store-badge google${cornerClass}"><img src="./assets/google-play.png" alt="Google Play" width="14" height="14"></span>`;
  }
  if (platform === 'both') {
    return (
      `<span class="store-badge both${cornerClass}" role="img" aria-label="App Store and Google Play">` +
      '<span class="store-badge-a"><img src="./assets/app-store.png" alt=""></span>' +
      '<span class="store-badge-b google"><img src="./assets/google-play.png" alt=""></span>' +
      '</span>'
    );
  }
  // Falls back to the Apple mark for `ios` and for an unknown/missing
  // platform alike — matches the original leaderboard behaviour: a resolved
  // App Store catalogue entry is at minimum a fact about the App Store,
  // never a guess, so the default reads as "at least this much is known."
  return `<span class="store-badge apple${cornerClass}"><img src="./assets/app-store.png" alt="App Store" width="14" height="14"></span>`;
}
