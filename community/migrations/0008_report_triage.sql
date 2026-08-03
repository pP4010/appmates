-- Structured triage for reports: a picked cause (not just free text), and
-- the two timestamps the push→email escalation (lib/push.js
-- notifyAdminsOfReportPush, routes/reports.js escalateUnseenReports) needs
-- to know whether — and when — a human actually looked.
--
-- Plain ADD COLUMN, not the rename-and-recreate dance 0002/0006 needed:
-- these are new nullable columns, not a CHECK constraint change.

ALTER TABLE reports ADD COLUMN cause TEXT;
ALTER TABLE reports ADD COLUMN seen_at TEXT;
ALTER TABLE reports ADD COLUMN escalated_at TEXT;

CREATE INDEX idx_reports_unseen ON reports(seen_at, escalated_at, created_at);
