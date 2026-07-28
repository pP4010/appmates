-- LaunchPilot Community: users, auth, listings, testing, tokens.
--
-- Design notes:
-- * Tokens are earned only (never purchased) — the ledger is the source of
--   truth and is append-only; `users.token_balance` is a cached sum kept in
--   sync by the same transaction that inserts a ledger row, never written
--   to directly from a client-supplied value.
-- * A test session only pays out once the LISTING OWNER marks it complete —
--   never the tester themselves — so nobody can award their own tokens.
-- * Nothing here stores or checks App Store/Play reviews or ratings; a
--   listing links out to a real TestFlight/Play link or a real store page,
--   and nothing about leaving a public review is tracked, required, or
--   rewarded here. That distinction is load-bearing, not incidental.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  token_balance INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  banned_at TEXT
);

-- Magic-link sign-in. Single-use, short-lived; consumed on verify.
CREATE TABLE magic_links (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_magic_links_email ON magic_links(email);

-- One row per request, so a burst of requests for the same email can be
-- rate-limited without scanning the whole table.
CREATE TABLE magic_link_requests (
  email TEXT NOT NULL,
  requested_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_magic_link_requests_email_time ON magic_link_requests(email, requested_at);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- One row per app a user has connected — the public App Store facts already
-- fetched by Overview, not re-entered by hand.
CREATE TABLE apps (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  track_id TEXT NOT NULL,
  bundle_id TEXT,
  name TEXT NOT NULL,
  artwork_url TEXT,
  store_url TEXT,
  country TEXT NOT NULL DEFAULT 'us',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(owner_user_id, track_id)
);
CREATE INDEX idx_apps_owner ON apps(owner_user_id);

-- One row per "ask": either recruiting closed testers before release, or
-- announcing a launch/update that shipped. `kind` is the only thing that
-- changes the copy shown — the row itself is the same shape either way, so
-- a listing can move from testing to launched without starting over.
CREATE TABLE listings (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('testing', 'launch')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'both')),
  link TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  slots_wanted INTEGER NOT NULL DEFAULT 0,
  featured_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_listings_status_kind ON listings(status, kind);
CREATE INDEX idx_listings_featured ON listings(featured_until);
CREATE INDEX idx_listings_owner ON listings(owner_user_id);

-- One row per tester who joined a listing. The tester marks their own
-- install/feedback as submitted; only the *owner* transitioning it to
-- `completed` mints a token — see token_ledger.
CREATE TABLE test_sessions (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listings(id),
  tester_user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'joined' CHECK (status IN ('joined', 'submitted', 'completed', 'abandoned')),
  feedback TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT,
  completed_at TEXT,
  UNIQUE(listing_id, tester_user_id)
);
CREATE INDEX idx_test_sessions_listing ON test_sessions(listing_id);
CREATE INDEX idx_test_sessions_tester ON test_sessions(tester_user_id);

-- Append-only. Every balance change is one row; `users.token_balance` is a
-- cache that must always equal SUM(delta) for that user — never written
-- from a value the client sent.
CREATE TABLE token_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('earned_test', 'spent_feature', 'refund', 'adjustment')),
  related_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_token_ledger_user ON token_ledger(user_id);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  reporter_user_id TEXT NOT NULL REFERENCES users(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('listing', 'user')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
