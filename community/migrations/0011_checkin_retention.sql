-- Check-in photos are proof of a moment ("I opened it today"), not an
-- archive — each one expires CHECKIN_RETENTION_DAYS (lib/config.js) after
-- its own date, purged by the hourly cron (`purgeExpiredPhotos` in
-- routes/checkins.js, wired into the same `scheduled` handler as report
-- escalation). The check-in ROW survives (date, streak history stays
-- useful); only `photo` is cleared, so `purged_at` records that it once
-- existed rather than the row looking indistinguishable from a check-in
-- that was somehow logged with no photo at all.
--
-- A session with any report filed against it (`reports.target_type =
-- 'session'`) is exempt for as long as that's true — there's no "resolved"
-- state on a report yet (see 0008), so this errs toward keeping evidence:
-- better to hold a photo too long than to purge it out from under a claim
-- someone is actively looking into.
--
-- `photo` needs to become nullable for the purge to clear it in place
-- rather than deleting the whole row — SQLite has no ALTER COLUMN, so
-- recreate, same dance as 0002/0006.

ALTER TABLE session_checkins RENAME TO session_checkins_old;

CREATE TABLE session_checkins (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES test_sessions(id),
  checkin_date TEXT NOT NULL,
  photo TEXT,
  purged_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, checkin_date)
);

INSERT INTO session_checkins (id, session_id, checkin_date, photo, created_at)
SELECT id, session_id, checkin_date, photo, created_at FROM session_checkins_old;

DROP TABLE session_checkins_old;

CREATE INDEX idx_session_checkins_session ON session_checkins(session_id);
-- Scoped to rows the purge job actually has to look at — a row already
-- purged (`photo IS NULL`) is dead weight to this index once photos start
-- aging out.
CREATE INDEX idx_session_checkins_purge ON session_checkins(checkin_date) WHERE photo IS NOT NULL;
