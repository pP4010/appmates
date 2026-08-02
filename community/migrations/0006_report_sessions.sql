-- Lets a test session's conversation be reported, not just a listing or a
-- user — the Inbox's report action (views/inbox.js) needs somewhere to
-- land. SQLite has no `ALTER ... ALTER COLUMN` for a CHECK constraint, so
-- the table is recreated, same pattern as 0002_testing_flow.sql.

ALTER TABLE reports RENAME TO reports_old;

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  reporter_user_id TEXT NOT NULL REFERENCES users(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('listing', 'user', 'session')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO reports (id, reporter_user_id, target_type, target_id, reason, created_at)
SELECT id, reporter_user_id, target_type, target_id, reason, created_at FROM reports_old;

DROP TABLE reports_old;

CREATE INDEX idx_reports_target ON reports(target_type, target_id);
