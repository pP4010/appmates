-- Daily proof-of-testing check-ins: one row per (session, day), so a tester
-- opening the app today and yesterday can't be told apart from opening it
-- once and claiming two days. `photo` is a compressed JPEG data URL, not a
-- file — no object storage exists in this deployment (see 0009's note on
-- avatars), and a photo this small (compressed client-side, capped
-- server-side at MAX_CHECKIN_PHOTO_CHARS in lib/config.js) fits comfortably
-- as TEXT rather than justifying a whole storage product for one feature.
--
-- Visible to both parties on the session (the tester who sent it, the
-- listing owner verifying it), same membership check as session_messages.

CREATE TABLE session_checkins (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES test_sessions(id),
  checkin_date TEXT NOT NULL, -- YYYY-MM-DD, in the tester's own submission — no server timezone guess
  photo TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, checkin_date)
);
CREATE INDEX idx_session_checkins_session ON session_checkins(session_id);
