-- Per-user, per-conversation notification mute. Deliberately server-side,
-- not a client-side flag like favourite/hidden/archived in the Inbox: the
-- decision of *whether to send a push at all* is made in the Worker
-- (notifyNewMessage, lib/push.js), and a Service Worker has no access to
-- localStorage to check a client-side flag against. This is the one piece
-- of "how do I want to see this conversation" state that has to live on
-- the server for the feature to work at all.

CREATE TABLE muted_conversations (
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES test_sessions(id),
  muted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, session_id)
);
