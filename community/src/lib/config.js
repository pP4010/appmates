/** Tunable numbers, kept in one place since they define the token economy. */
export const FEATURE_COST_PER_DAY = 3;
export const MAX_FEATURE_DAYS = 14;
export const TOKENS_PER_COMPLETED_TEST = 1;
export const MAX_SLOTS_WANTED = 100;
export const MAX_DESCRIPTION_LENGTH = 2000;
export const MAX_FEEDBACK_LENGTH = 4000;

// A request to join a test is a short pitch, not a form field — long enough
// that "hi" or "add me" can't pass, short enough it isn't a second feedback
// box. Mirrors the bar TrustMRR sets on its own contact-seller message.
export const MIN_REQUEST_MESSAGE_LENGTH = 20;
export const MAX_REQUEST_MESSAGE_LENGTH = 1000;
export const MAX_NAME_LENGTH = 80;
// A profile bio ("what are you building or looking to test?") — short on
// purpose, same reasoning as TrustMRR's own 180-character cap: long enough
// to say something real, short enough it can't turn into a pitch deck.
export const MAX_BIO_LENGTH = 180;

// Below this many resolved sessions, a completion rate is noise, not a
// signal — showing one anyway would read as a real score for a coin flip.
export const MIN_RESOLVED_FOR_RELIABILITY = 3;

export const LEADERBOARD_DEFAULT_WINDOW_DAYS = 30;
export const LEADERBOARD_MAX_WINDOW_DAYS = 365;
export const LEADERBOARD_LIMIT = 20;
// The ceiling a "show more" can raise the board to. Capped so a crafted
// `?limit=` can't turn a public endpoint into a full table scan.
export const LEADERBOARD_MAX_LIMIT = 100;

// How many top contributors get their own listings surfaced alongside the
// board. Small on purpose: the point is a visible reward for giving back,
// not a second full marketplace.
export const CONTRIBUTOR_SHOWCASE_LIMIT = 6;

// Kept in sync by hand with `RAIL_COLORS` in web/landing.js — the swatches
// a "Feature your app here" submission can pick from. Validated here so a
// crafted request can't store a `color` the rail-card CSS has no rule for.
export const PROMO_COLORS = [
  'blue', 'green', 'violet', 'orange', 'pink', 'teal', 'red', 'amber', 'indigo', 'slate',
];
// Same bar as a test request's pitch (`MIN_REQUEST_MESSAGE_LENGTH` above):
// long enough to say something real about the app, short enough it isn't a
// second feedback box.
export const MIN_PROMO_MESSAGE_LENGTH = 20;
export const MAX_PROMO_MESSAGE_LENGTH = 1000;

// A message on a test session's thread — deliberately looser than a first
// pitch (no minimum): "ok, sent you a new invite" is a complete message.
export const MAX_SESSION_MESSAGE_LENGTH = 2000;

// A daily check-in's photo, as a base64 data URL. 260,000 chars is roughly
// 190KB of actual image data once decoded (base64 is ~4/3 the raw size) —
// generous for a client-side-compressed JPEG (web/views/be-tester.js
// targets well under half that) while still keeping one row small enough
// that this stays a TEXT column, not a reason to add object storage.
export const MAX_CHECKIN_PHOTO_CHARS = 260_000;
// A generous ceiling on the whole request body (photo plus JSON wrapper),
// checked against `content-length` before the body is even parsed — a
// legitimate client's compressed photo lands nowhere near this, so it only
// ever rejects someone bypassing the client entirely to post an oversized
// payload straight at the API.
export const MAX_CHECKIN_REQUEST_BYTES = 400_000;

// How long a check-in's photo is kept before the hourly purge clears it
// (`purgeExpiredPhotos` in routes/checkins.js) — the check-in row itself
// (date, streak history) is untouched, only the image. Matches the window
// the feature is already built around: Play's own closed-testing streak
// needs 14 continuous days, so a photo has no reason to outlive that.
export const CHECKIN_RETENTION_DAYS = 14;

// A conversation report — enough room to actually explain what's wrong,
// short enough it isn't a second feedback box. Mirrors the bar a request
// pitch clears (MIN_REQUEST_MESSAGE_LENGTH above).
export const MIN_REPORT_REASON_LENGTH = 10;
export const MAX_REPORT_REASON_LENGTH = 1000;
export const MAX_REPORT_EVIDENCE_LENGTH = 1000;

// The picked reason on a report — validated server-side so a crafted
// request can't store a `cause` the admin view has no label for. Kept in
// sync by hand with `REPORT_CAUSE_LABELS` in web/views/inbox.js.
export const REPORT_CAUSES = ['fraud', 'abuse', 'spam', 'sensitive', 'other'];

// How long an admin has to actually look at a report (opening #admin marks
// every pending one "seen") before the push-only alert escalates to email —
// long enough that a missed push overnight isn't already an email by
// morning, short enough that nothing sits unnoticed for more than two days.
export const REPORT_ESCALATION_HOURS = 48;

// The one non-real participant in the system: a fixed bot user + app +
// listing (see migrations/0005_echo_test_conversation.sql) that echoes
// back whatever you send it, so push notifications can be watched arriving
// for real — tab open (a toast) or backgrounded/closed (a system
// notification) — without a second real account. `status = 'closed'` on
// its listing keeps it out of the public marketplace forever.
export const ECHO_BOT_USER_ID = '00000000-0000-4000-8000-000000000001';
export const ECHO_BOT_LISTING_ID = '00000000-0000-4000-8000-000000000003';
export const ECHO_REPLY_DELAY_MS = 5000;
