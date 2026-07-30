-- Adds a review step to joining a test (request -> accept/decline, instead
-- of an instant join), plus a short structured evaluation the tester fills
-- in alongside their free-text feedback. See ../README.md.
--
-- SQLite has no `ALTER ... ALTER COLUMN` for a CHECK constraint, so the
-- table is recreated and the old rows are copied across. `joined` (the only
-- status that used to mean "actively testing, no review happened") becomes
-- `accepted`, since every row that reached it did so through the old
-- one-click join.

ALTER TABLE test_sessions RENAME TO test_sessions_old;

CREATE TABLE test_sessions (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listings(id),
  tester_user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'declined', 'accepted', 'submitted', 'completed', 'abandoned')),
  request_message TEXT NOT NULL DEFAULT '',
  responded_at TEXT,
  feedback TEXT,
  bug_found INTEGER CHECK (bug_found IN (0, 1)),
  would_use_again TEXT CHECK (would_use_again IN ('yes', 'no', 'maybe')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT,
  completed_at TEXT,
  UNIQUE(listing_id, tester_user_id)
);

INSERT INTO test_sessions
  (id, listing_id, tester_user_id, status, feedback, created_at, submitted_at, completed_at)
SELECT id, listing_id, tester_user_id,
  CASE status WHEN 'joined' THEN 'accepted' ELSE status END,
  feedback, created_at, submitted_at, completed_at
FROM test_sessions_old;

DROP TABLE test_sessions_old;

CREATE INDEX idx_test_sessions_listing ON test_sessions(listing_id);
CREATE INDEX idx_test_sessions_tester ON test_sessions(tester_user_id);
CREATE INDEX idx_test_sessions_status ON test_sessions(status);
