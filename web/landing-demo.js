/**
 * Sample content for the landing page.
 *
 * The landing page has to explain the product before anyone has signed up,
 * which means it has to look inhabited on a deployment where the community
 * backend is switched off — the state every fresh clone starts in. These
 * rows fill that gap and are replaced wholesale the moment
 * `COMMUNITY_API_URL` is set (see `landing.js`).
 *
 * The page says so on the page, not only here (`data-demo` in index.html
 * renders the visible "sample" tag): passing placeholder numbers off as
 * traction is the one thing a landing page for a product about *verified*
 * listing data must not do. The apps below are real — the site's own,
 * genuinely on the App Store, before any third-party listing exists to
 * show instead — but the per-row counts that aren't public App Store
 * facts (testers signed up, High Fives, days left) are still invented,
 * same as the "sample" tag says.
 */

// The site's own 2 apps — the only real listings that exist before anyone
// else has posted one. `trackId`/`country` let landing.js patch in each
// app's real icon, genre and (for DEMO_LAUNCHED) rating straight from the
// public catalogue; `note` and the counts below it are placeholders (this
// isn't backed by a real community session) — edit them once real numbers
// exist. Still tagged "sample" on the page either way (see index.html's
// `data-demo` span), so this never reads as live traction.
export const DEMO_TESTING = [
  {
    name: 'Rebuild: Resist & Build',
    trackId: '6782585843',
    country: 'us',
    genre: 'Health & Fitness',
    testers: '0/12',
    helped: 0,
    daysLeft: 14,
    note: 'Looking for Google Play closed testers.',
  },
];

export const DEMO_LAUNCHED = [
  {
    name: 'Kaizen - Screen Time & Detox',
    trackId: '6768688178',
    country: 'us',
    genre: 'Productivity',
    note: 'Live on the App Store.',
  },
  {
    name: 'Rebuild: Resist & Build',
    trackId: '6782585843',
    country: 'us',
    genre: 'Health & Fitness',
    note: 'Live on the App Store.',
  },
];

/** Every field here has a real counterpart the backend returns, so the live
 * board renders the same columns rather than a thinner version of this one:
 * `apps` ← apps_helped, `ownApp` ← the tester's connected app, and so on.
 *
 * `ownApp: null` is deliberately common. Plenty of good testers have not
 * shipped anything yet, and a board that implied otherwise would misread
 * who this community is for — so the column shows a dash, not a blank.
 * `ratings` stands in for what the live board re-reads from the public
 * catalogue; it is a property of the app, never a score earned here.
 *
 * `ownApp` is usually a plain string — a name with no catalogue entry
 * behind it, same as the rest of this sample data. The two rows below are
 * the exception: the site owner's own apps, given as `{ name, trackId,
 * country }` the same shape `RAIL_LEFT`/`RAIL_RIGHT` use below, so
 * `landing.js` resolves their icon, real title and category from the
 * catalogue instead of showing this file's guess. `ownAppDesc`/`ratings`
 * stay `null` for those two — filled in live, not worth going stale here. */
export const DEMO_LEADERBOARD = [
  { rank: 1, name: 'Mara V.', tests: 23, apps: 14, ownApp: 'Habitloop', ownAppDesc: 'Productivity · Habit streaks', ratings: '1,204' },
  { rank: 2, name: 'devonp', tests: 19, apps: 11, ownApp: null, ownAppDesc: null, ratings: null },
  { rank: 3, name: 'Kit Sørensen', tests: 17, apps: 12, ownApp: 'Ferment', ownAppDesc: 'Food & Drink · Sourdough timers', ratings: '318' },
  { rank: 4, name: 'anna.builds', tests: 15, apps: 9, ownApp: 'Inkwell', ownAppDesc: 'Productivity · Markdown notes', ratings: '96' },
  { rank: 5, name: 'Paolo A.', tests: 14, apps: 9, ownApp: { name: 'Kaizen', trackId: '6768688178', country: 'us' }, ownAppDesc: null, ratings: null },
  { rank: 6, name: 'Tobi A.', tests: 13, apps: 10, ownApp: null, ownAppDesc: null, ratings: null },
  { rank: 7, name: 'nine_lives', tests: 12, apps: 6, ownApp: 'Cadence', ownAppDesc: 'Music · Metronome & setlists', ratings: '1,309' },
  { rank: 8, name: 'Priya R.', tests: 11, apps: 8, ownApp: 'Quietly', ownAppDesc: 'Health & Fitness · Sleep sounds', ratings: '47' },
  { rank: 9, name: 'Paolo A.', tests: 10, apps: 7, ownApp: { name: 'Rebuild', trackId: '6782585843', country: 'us' }, ownAppDesc: null, ratings: null },
  { rank: 10, name: 'joon.dev', tests: 9, apps: 7, ownApp: null, ownAppDesc: null, ratings: null },
  { rank: 11, name: 'Elif K.', tests: 8, apps: 5, ownApp: 'Fernweh', ownAppDesc: 'Travel · Offline city maps', ratings: '624' },
  { rank: 12, name: 'marcus_b', tests: 7, apps: 6, ownApp: 'Trailmix', ownAppDesc: 'Health & Fitness · Trail routes', ratings: '12' },
  { rank: 13, name: 'Sofia L.', tests: 6, apps: 4, ownApp: null, ownAppDesc: null, ratings: null },
  { rank: 14, name: 'pixelwright', tests: 5, apps: 5, ownApp: 'Bulletpoint', ownAppDesc: 'Productivity · Outliner', ratings: '431' },
];

/**
 * The promoted slots down either side of the page.
 *
 * The two real entries are the site owner's own apps, filled in from the
 * public catalogue at render time rather than hardcoded here — a name or an
 * icon pasted into source goes stale the moment the listing changes. The
 * empty ones are the offer: a slot someone can ask for, priced later.
 */
/**
 * `name` is only a fallback label. The card normally shows whatever the
 * catalogue returns — that is what keeps it current — but a lookup can
 * fail, and a promoted slot reading "Promoted app" instead of the app's
 * actual name is a worse outcome than a slightly stale one.
 *
 * `color` picks one of `RAIL_COLORS` in `landing.js` — the same palette a
 * visitor requesting an open slot chooses from — and survives a failed
 * lookup (`unresolvedSlot` carries it through too), since a slot's colour
 * was chosen at purchase time, not read from the catalogue.
 *
 * The empty slots below each list are not fixed: `landing.js` generates as
 * many as the viewport has room for, so the column is full at any height.
 */
export const RAIL_LEFT = [{ trackId: '6768688178', country: 'us', name: 'Kaizen', color: 'blue' }];

export const RAIL_RIGHT = [{ trackId: '6782585843', country: 'us', name: 'Rebuild', color: 'green' }];
