-- Adds promoted-slot requests (the "Feature your app here" dialog on the
-- landing page) and a message thread on test sessions, so a tester and a
-- listing owner can talk beyond the single opening pitch. See ../README.md.

-- One row per "Feature your app here" submission. No `owner_user_id` /
-- FK to `users`: this is a business inquiry, not a marketplace action, and
-- requiring an account just to ask about a promoted slot would be friction
-- for no reason — a name and an email to reply to is enough, the same bar
-- a tester's first anonymous contact clears in `listings.request`.
--
-- `color` has no CHECK constraint on purpose: the palette lives in
-- `RAIL_COLORS` (web/landing.js) and `PROMO_COLORS` (lib/config.js), and
-- both are far more likely to grow a new swatch than this table is to need
-- a migration for it. The route validates against `PROMO_COLORS` instead.
CREATE TABLE promo_requests (
  id TEXT PRIMARY KEY,
  requester_name TEXT NOT NULL,
  requester_email TEXT NOT NULL,
  track_id TEXT NOT NULL,
  app_name TEXT NOT NULL,
  app_genre TEXT,
  artwork_url TEXT,
  store_url TEXT,
  color TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT
);
CREATE INDEX idx_promo_requests_status ON promo_requests(status, created_at);

-- One row per message on a test session's thread. The opening pitch stays
-- where it already lived (`test_sessions.request_message`) — this table is
-- everything exchanged after that, in either direction, once the tester and
-- the listing owner actually need to coordinate (a device they don't have,
-- a build that needs a new TestFlight invite, and so on).
CREATE TABLE session_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES test_sessions(id),
  sender_user_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_session_messages_session ON session_messages(session_id, created_at);
