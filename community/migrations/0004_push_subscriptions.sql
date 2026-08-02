-- Web Push subscriptions for the "new message" notification.
--
-- One row per browser/device a user has enabled notifications on — not one
-- per user, since the same account can be signed in on a phone and a
-- laptop, and each needs its own subscription to receive a push. `endpoint`
-- is unique because re-subscribing the same browser (permission re-granted,
-- service worker re-registered) should update the existing row, not pile up
-- duplicates that the push service will happily keep accepting sends for.

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);
