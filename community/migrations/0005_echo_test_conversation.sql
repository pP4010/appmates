-- A permanent, shared "echo test" conversation for verifying push
-- notifications actually reach a browser: send it a message and it replies
-- a few seconds later (see ECHO_BOT_USER_ID / scheduleEchoReply in
-- src/lib/push.js), so you can watch a real push arrive with the tab open
-- (an in-app toast) and with it backgrounded or closed (a system
-- notification) — without needing a second real account.
--
-- `status = 'closed'` on the listing keeps it out of `browse()`'s
-- `WHERE l.status = 'open'` filter permanently — nobody sees this in the
-- marketplace. Each real user gets their own test_sessions row against it
-- lazily, created on first use by routes/push.js `testSession`, not
-- provisioned here — this migration only creates the bot and its one
-- listing, once.

INSERT INTO users (id, email, display_name)
VALUES ('00000000-0000-4000-8000-000000000001', 'echo-bot@appmates.internal', 'AppMates Echo Bot');

INSERT INTO apps (id, owner_user_id, track_id, name, store_url, country)
VALUES (
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000001',
  '0',
  'AppMates Echo Test',
  'https://appmates.heykaizen.app',
  'us'
);

INSERT INTO listings (id, app_id, owner_user_id, kind, status, platform, link, description)
VALUES (
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000001',
  'testing',
  'closed',
  'both',
  'https://appmates.heykaizen.app',
  'Internal conversation for testing push notifications. Anything sent here is echoed back a few seconds later.'
);
