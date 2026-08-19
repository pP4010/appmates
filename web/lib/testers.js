/**
 * Google Play closed-testing eligibility — the browser counterpart of
 * `core/services/google_play`.
 *
 * Personal developer accounts created after 13 November 2023 must run a closed
 * test with at least 12 testers opted in **continuously** for 14 days before
 * applying for production access. Organisation accounts are exempt.
 *
 * The subtlety worth the code: the 14 days must be unbroken. A naive
 * `days >= 14 && testers >= 12` reports success for a timeline that dipped to
 * eleven on day nine — and the developer finds out on day fourteen that Google
 * restarted the clock.
 */

let REQUIRED_TESTERS = 12;
let REQUIRED_DAYS = 14;

export function loadTestingSpec(specs) {
  const config = specs.closed_testing ?? specs;
  REQUIRED_TESTERS = config.required_testers ?? REQUIRED_TESTERS;
  REQUIRED_DAYS = config.required_days ?? REQUIRED_DAYS;
}

export function requirements() {
  return { requiredTesters: REQUIRED_TESTERS, requiredDays: REQUIRED_DAYS };
}

const DAY_MS = 86_400_000;

function toDate(value) {
  return value instanceof Date ? value : new Date(`${value}T00:00:00Z`);
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Measure the current and longest unbroken runs at or above the threshold.
 *
 * A gap in the dates breaks the streak: a day with no recorded opt-ins cannot
 * be counted as met, and silently bridging it would report eligibility the
 * developer does not have.
 */
function measureStreaks(history, requiredTesters) {
  let current = 0;
  let longest = 0;
  let start = null;
  let wasReset = false;
  let previous = null;

  for (const day of history) {
    const date = toDate(day.date);
    const contiguous = previous === null || (date - previous) / DAY_MS === 1;

    if (day.optedIn >= requiredTesters && contiguous) {
      current += 1;
      if (current === 1) start = date;
    } else if (day.optedIn >= requiredTesters) {
      if (current > 0) wasReset = true;
      current = 1;
      start = date;
    } else {
      if (current > 0) wasReset = true;
      current = 0;
      start = null;
    }
    longest = Math.max(longest, current);
    previous = date;
  }

  return { current, longest, start, wasReset };
}

/**
 * Assess a closed test against Play's production-access requirements.
 *
 * `history` is a per-day tester count in any order.
 */
export function evaluateTesting(
  history,
  { requiredTesters = REQUIRED_TESTERS, requiredDays = REQUIRED_DAYS, releaseApproved = true, today = new Date() } = {},
) {
  const ordered = [...history].sort((a, b) => toDate(a.date) - toDate(b.date));
  let { current, longest, start, wasReset } = measureStreaks(ordered, requiredTesters);
  const active = ordered.length ? ordered[ordered.length - 1].optedIn : 0;

  if (!releaseApproved) {
    // Play does not start counting until the build is live to testers.
    current = 0;
    start = null;
  }

  const eligible = releaseApproved && active >= requiredTesters && current >= requiredDays;
  const daysRemaining = Math.max(0, requiredDays - current);

  // Codes and wording are matched to the Python engine exactly; the conformance
  // suite compares them, and the two implementations are meant to be one
  // product rather than two that broadly agree.
  const blockers = [];
  if (!releaseApproved) {
    blockers.push({
      code: 'RELEASE_NOT_APPROVED',
      message:
        'The closed-testing release is not approved yet. The 14-day clock does not ' +
        'start until Google approves it.',
    });
  }
  if (active < requiredTesters) {
    blockers.push({
      code: 'NOT_ENOUGH_TESTERS',
      message:
        `${active}/${requiredTesters} testers opted in. Recruit ${requiredTesters - active} more. ` +
        'A tester only counts once they accept the invite and install the build.',
    });
  }
  if (current < requiredDays) {
    blockers.push({
      code: 'STREAK_TOO_SHORT',
      message:
        `${current}/${requiredDays} continuous days met. ${requiredDays - current} to go.`,
    });
  }
  if (wasReset) {
    blockers.push({
      code: 'STREAK_RESET',
      message:
        'The tester count dropped below the threshold, which restarted the 14-day ' +
        'count. Keep every tester opted in until you apply.',
    });
  }

  const projected =
    !eligible && active >= requiredTesters && releaseApproved
      ? isoDate(new Date(today.getTime() + daysRemaining * DAY_MS))
      : null;

  return {
    eligible,
    activeTesters: active,
    requiredTesters,
    requiredDays,
    currentStreakDays: current,
    longestStreakDays: longest,
    streakStart: start ? isoDate(start) : null,
    daysRemaining,
    projectedDate: projected,
    wasReset,
    blockers,
    progress: Math.round((1000 * Math.min(current, requiredDays)) / requiredDays) / 10,
  };
}

/**
 * Build a flat timeline from a simple "N days at M testers" description.
 *
 * Kept explicit because it cannot detect a dip by construction — the UI says so
 * rather than letting a flat entry imply an unbroken streak it never verified.
 */
export function flatHistory(daysPassed, activeTesters, today = new Date()) {
  const history = [];
  for (let offset = daysPassed - 1; offset >= 0; offset -= 1) {
    history.push({
      date: isoDate(new Date(today.getTime() - offset * DAY_MS)),
      optedIn: activeTesters,
    });
  }
  return history;
}

/**
 * TestFlight has no numeric gate like Play's — a build is simply testable by
 * anyone added (individual) or anyone with the link (public group) once it
 * clears Beta App Review, and stops being testable 90 days after upload
 * regardless of tester count. That expiry is the one thing worth computing.
 */
export function testFlightExpiry(uploadedAt, today = new Date()) {
  const uploaded = toDate(uploadedAt);
  const expires = new Date(uploaded.getTime() + 90 * DAY_MS);
  const daysLeft = Math.ceil((expires.getTime() - today.getTime()) / DAY_MS);
  return { expiresOn: isoDate(expires), daysLeft, expired: daysLeft <= 0 };
}

/** Parse a pasted JSON timeline, tolerating both key spellings. */
export function parseHistory(text) {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('Expected a JSON array of daily counts.');
  return parsed.map((row) => {
    const optedIn = row.optedIn ?? row.opted_in;
    if (!row.date || optedIn === undefined) {
      throw new Error('Each entry needs a "date" and an "opted_in" count.');
    }
    return { date: String(row.date), optedIn: Number(optedIn) };
  });
}
