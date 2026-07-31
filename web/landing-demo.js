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

export const DEMO_TESTING = [
  {
    name: 'Habitloop',
    genre: 'Productivity',
    testers: '9/12',
    health: 91,
    daysLeft: 4,
    note: 'Streak logic and the widget refresh',
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

export const DEMO_LEADERBOARD = [
  { rank: 1, name: 'Mara V.', tests: 23, tokens: 23, apps: 4 },
  { rank: 2, name: 'devonp', tests: 19, tokens: 19, apps: 2 },
  { rank: 3, name: 'Kit Sørensen', tests: 17, tokens: 17, apps: 3 },
  { rank: 4, name: 'anna.builds', tests: 12, tokens: 12, apps: 1 },
  { rank: 5, name: 'Tobi A.', tests: 11, tokens: 11, apps: 2 },
  { rank: 6, name: 'nine_lives', tests: 9, tokens: 9, apps: 1 },
  { rank: 7, name: 'Priya R.', tests: 8, tokens: 8, apps: 2 },
];
