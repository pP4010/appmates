import { json, error, newId } from '../lib/http.js';
import { currentUser } from '../lib/auth.js';
import { MAX_CHECKIN_PHOTO_CHARS, MAX_CHECKIN_REQUEST_BYTES, CHECKIN_RETENTION_DAYS } from '../lib/config.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,/;

/** Same membership shape as `sessionParties` in messages.js — kept as its
 * own copy rather than imported, since the two queries already differ (this
 * one needs `responded_at` to bound how far back a check-in can be dated,
 * not `app_name`) and check-ins may end up with their own membership
 * nuances (e.g. an owner-side "request a check-in" action) that
 * messages.js has no reason to grow. */
async function sessionParties(env, id) {
  return env.DB.prepare(
    `SELECT ts.id, ts.status, ts.tester_user_id, ts.responded_at, l.owner_user_id AS listing_owner_id
     FROM test_sessions ts JOIN listings l ON l.id = ts.listing_id
     WHERE ts.id = ?`,
  )
    .bind(id)
    .first();
}

function isParty(session, userId) {
  return Boolean(session) && (session.tester_user_id === userId || session.listing_owner_id === userId);
}

function serialize(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    date: row.checkin_date,
    photo: row.photo,
    purgedAt: row.purged_at,
    createdAt: row.created_at,
  };
}

/** Every check-in on one session, oldest first — visible to both parties,
 * same as the message thread: the tester sees their own streak, the owner
 * sees the proof they're verifying. */
export async function list(request, env, id) {
  const user = await currentUser(env, request);
  if (!user) return error(env, request, 401, 'sign in required');

  const session = await sessionParties(env, id);
  if (!isParty(session, user.id)) return error(env, request, 404, 'test session not found');

  const { results } = await env.DB.prepare(
    'SELECT * FROM session_checkins WHERE session_id = ? ORDER BY checkin_date ASC',
  )
    .bind(id)
    .all();
  return json(env, request, { checkins: results.map(serialize) });
}

/**
 * The tester logs today (or a specific date, if they're backfilling a day
 * they forgot to check in) as tested, with a photo as evidence. Only the
 * tester on an `accepted` session can post — not the owner, and not once
 * the test has moved past `accepted` (submitted/completed testing is done;
 * requested/declined never started). `UNIQUE(session_id, checkin_date)` on
 * the table is the real enforcement of "once per day"; the app-level error
 * below just gives it a clean message instead of a raw constraint failure.
 */
export async function create(request, env, id) {
  const user = await currentUser(env, request);
  if (!user) return error(env, request, 401, 'sign in required');

  const session = await sessionParties(env, id);
  if (!session || session.tester_user_id !== user.id) {
    return error(env, request, 404, 'test session not found');
  }
  if (session.status !== 'accepted') {
    return error(env, request, 400, `cannot check in from status "${session.status}"`);
  }

  // Checked before the body is parsed, not just after (see the length
  // check on `photo` below) — a legitimate client's compressed photo is
  // nowhere near this, so this only ever catches someone bypassing the
  // client to post an oversized payload straight at the API, before the
  // Worker spends memory buffering and parsing it as JSON.
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_CHECKIN_REQUEST_BYTES) {
    return error(env, request, 413, 'request body is too large');
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return error(env, request, 400, 'expected JSON body');
  }

  const date = String(body?.date ?? '');
  if (!DATE_RE.test(date)) return error(env, request, 400, 'date must be YYYY-MM-DD');

  const today = new Date().toISOString().slice(0, 10);
  if (date > today) return error(env, request, 400, 'date cannot be in the future');
  // A check-in is proof testing happened *during* this active test, not a
  // free-floating claim — without this, a tester could backfill a streak
  // for dates before the owner ever accepted them.
  if (session.responded_at && date < session.responded_at.slice(0, 10)) {
    return error(env, request, 400, 'date cannot be before this test was accepted');
  }

  const photo = String(body?.photo ?? '');
  if (!DATA_URL_RE.test(photo)) return error(env, request, 400, 'photo must be a JPEG, PNG or WebP data URL');
  if (photo.length > MAX_CHECKIN_PHOTO_CHARS) return error(env, request, 400, 'photo is too large');

  const existing = await env.DB.prepare(
    'SELECT id FROM session_checkins WHERE session_id = ? AND checkin_date = ?',
  )
    .bind(id, date)
    .first();
  if (existing) return error(env, request, 409, `already checked in for ${date}`);

  const checkinId = newId();
  await env.DB.prepare('INSERT INTO session_checkins (id, session_id, checkin_date, photo) VALUES (?, ?, ?, ?)')
    .bind(checkinId, id, date, photo)
    .run();

  const row = await env.DB.prepare('SELECT * FROM session_checkins WHERE id = ?').bind(checkinId).first();
  return json(env, request, { checkin: serialize(row) }, { status: 201 });
}

/**
 * Runs on the Worker's hourly cron (see `scheduled` in index.js), same
 * trigger as report escalation. Clears `photo` — not the row — on every
 * check-in older than `CHECKIN_RETENTION_DAYS`, except on a session that
 * has ever had a report filed against it (`reports.target_type =
 * 'session'`): there's no "resolved" state on a report yet (see 0008's
 * migration note), so this errs toward keeping evidence rather than
 * guessing when an investigation is actually over. `purged_at` records
 * that a photo once existed, so the UI can say so instead of rendering a
 * blank thumbnail indistinguishable from a check-in that never had one.
 */
export async function purgeExpiredPhotos(env) {
  const result = await env.DB.prepare(
    `UPDATE session_checkins
     SET photo = NULL, purged_at = datetime('now')
     WHERE photo IS NOT NULL
       AND checkin_date < date('now', ?)
       AND session_id NOT IN (SELECT target_id FROM reports WHERE target_type = 'session')`,
  )
    .bind(`-${CHECKIN_RETENTION_DAYS} days`)
    .run();
  return result.meta?.changes ?? 0;
}
