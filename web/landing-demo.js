/**
 * Sample content for the landing page.
 *
 * The landing page has to explain the product before anyone has signed up,
 * which means it has to look inhabited on a deployment where the community
 * backend is switched off — the state every fresh clone starts in. These
 * rows fill that gap and are replaced wholesale the moment
 * `COMMUNITY_API_URL` is set (see `landing.js`).
 *
 * The apps are invented, not real listings, and the page says so on the
 * page rather than only here: passing placeholder numbers off as traction
 * is the one thing a landing page for a product about *verified* listing
 * data must not do. Icons are generated letter tiles for the same reason —
 * a real app's logo here would imply a customer who doesn't exist.
 */

/** `featured` mirrors what a real listing gets by spending tokens: a tinted
 * card with a slow highlight sweep. Kept rare on purpose — the effect only
 * means anything while most cards don't have it. */
export const DEMO_TESTING = [
  {
    name: 'Habitloop',
    genre: 'Productivity',
    testers: '9/12',
    health: 91,
    daysLeft: 4,
    note: 'Streak logic and the widget refresh',
    featured: true,
  },
  {
    name: 'Ferment',
    genre: 'Food & Drink',
    testers: '5/12',
    health: 78,
    daysLeft: 11,
    note: 'Sourdough timers, offline mode',
  },
  {
    name: 'Trailmix',
    genre: 'Health & Fitness',
    testers: '12/12',
    health: 84,
    daysLeft: 2,
    note: 'GPS drift on long routes',
  },
  {
    name: 'Inkwell',
    genre: 'Productivity',
    testers: '3/12',
    health: 62,
    daysLeft: 13,
    note: 'Markdown export, iPad split view',
  },
  {
    name: 'Quietly',
    genre: 'Health & Fitness',
    testers: '7/12',
    health: 88,
    daysLeft: 6,
    note: 'Sleep sounds, background audio',
    featured: true,
  },
  {
    name: 'Snapcook',
    genre: 'Food & Drink',
    testers: '2/12',
    health: 71,
    daysLeft: 14,
    note: 'Recipe scanning accuracy',
  },
];

export const DEMO_LAUNCHED = [
  {
    name: 'Tempo Run',
    genre: 'Health & Fitness',
    health: 94,
    rating: '4.7',
    ratings: '2,140',
    note: 'v2.0 — live pacing',
    featured: true,
  },
  {
    name: 'Sunbeam',
    genre: 'Weather',
    health: 89,
    rating: '4.6',
    ratings: '870',
    note: 'Hourly radar rewrite',
  },
  {
    name: 'Bulletpoint',
    genre: 'Productivity',
    health: 82,
    rating: '4.4',
    ratings: '431',
    note: 'Shipped after 3 weeks of beta',
  },
  {
    name: 'Cadence',
    genre: 'Music',
    health: 76,
    rating: '4.8',
    ratings: '1,309',
    note: 'Metronome + setlists',
  },
  {
    name: 'Fernweh',
    genre: 'Travel',
    health: 90,
    rating: '4.5',
    ratings: '624',
    note: 'Offline maps for 40 cities',
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
 * catalogue; it is a property of the app, never a score earned here. */
export const DEMO_LEADERBOARD = [
  { rank: 1, name: 'Mara V.', tests: 23, apps: 14, ownApp: 'Habitloop', ownAppDesc: 'Productivity · Habit streaks', ratings: '1,204' },
  { rank: 2, name: 'devonp', tests: 19, apps: 11, ownApp: null, ownAppDesc: null, ratings: null },
  { rank: 3, name: 'Kit Sørensen', tests: 17, apps: 12, ownApp: 'Ferment', ownAppDesc: 'Food & Drink · Sourdough timers', ratings: '318' },
  { rank: 4, name: 'anna.builds', tests: 15, apps: 9, ownApp: 'Inkwell', ownAppDesc: 'Productivity · Markdown notes', ratings: '96' },
  { rank: 5, name: 'Tobi A.', tests: 13, apps: 10, ownApp: null, ownAppDesc: null, ratings: null },
  { rank: 6, name: 'nine_lives', tests: 12, apps: 6, ownApp: 'Cadence', ownAppDesc: 'Music · Metronome & setlists', ratings: '1,309' },
  { rank: 7, name: 'Priya R.', tests: 11, apps: 8, ownApp: 'Quietly', ownAppDesc: 'Health & Fitness · Sleep sounds', ratings: '47' },
  { rank: 8, name: 'joon.dev', tests: 9, apps: 7, ownApp: null, ownAppDesc: null, ratings: null },
  { rank: 9, name: 'Elif K.', tests: 8, apps: 5, ownApp: 'Fernweh', ownAppDesc: 'Travel · Offline city maps', ratings: '624' },
  { rank: 10, name: 'marcus_b', tests: 7, apps: 6, ownApp: 'Trailmix', ownAppDesc: 'Health & Fitness · Trail routes', ratings: '12' },
  { rank: 11, name: 'Sofia L.', tests: 6, apps: 4, ownApp: null, ownAppDesc: null, ratings: null },
  { rank: 12, name: 'pixelwright', tests: 5, apps: 5, ownApp: 'Bulletpoint', ownAppDesc: 'Productivity · Outliner', ratings: '431' },
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
 * The empty slots below each list are not fixed: `landing.js` generates as
 * many as the viewport has room for, so the column is full at any height.
 */
export const RAIL_LEFT = [{ trackId: '6768688178', country: 'us', name: 'Kaizen' }];

export const RAIL_RIGHT = [{ trackId: '6782585843', country: 'us', name: 'Rebuild' }];
