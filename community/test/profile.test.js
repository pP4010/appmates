import { test } from 'node:test';
import assert from 'node:assert/strict';

import { update, stats } from '../src/routes/profile.js';

const env = { APP_ORIGIN: 'https://example.com' };

/** A minimal D1 fake that dispatches by a keyword in the SQL text, the same
 * trick every prepared statement here is distinguishable by. `currentUser`
 * (lib/auth.js) is exercised for real — not mocked — so these tests cover
 * the actual sign-in gate on both routes, not a stand-in for it. */
function fakeDb({ user, reliabilityRow = {} } = {}) {
  const updates = [];
  return {
    updates,
    prepare(sql) {
      if (sql.includes('FROM sessions s')) {
        return { bind: (token) => ({ first: async () => (token === 'tok1' ? user : null) }) };
      }
      if (sql.trim().startsWith('UPDATE users SET display_name')) {
        return {
          bind: (...args) => ({
            run: async () => {
              updates.push(args);
              return { success: true };
            },
          }),
        };
      }
      if (sql.includes('completed_count')) {
        return { bind: () => ({ first: async () => reliabilityRow }) };
      }
      throw new Error(`unexpected SQL in profile test: ${sql}`);
    },
  };
}

function requestWithCookie(body) {
  return new Request('https://relay.example/profile', {
    method: 'POST',
    headers: { cookie: 'lp_session=tok1', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const USER = { id: 'user1', email: 'dev@example.com', display_name: 'Old Name', bio: null, avatar_url: null, token_balance: 4 };

test('update rejects an unauthenticated caller', async () => {
  const db = fakeDb({ user: null });
  const request = new Request('https://relay.example/profile', {
    method: 'POST',
    body: JSON.stringify({ displayName: 'Marc' }),
  });
  const response = await update(request, { ...env, DB: db });
  assert.equal(response.status, 401);
});

test('update rejects a blank name', async () => {
  const db = fakeDb({ user: USER });
  const request = requestWithCookie({ displayName: '   ', bio: 'hi' });
  const response = await update(request, { ...env, DB: db });
  assert.equal(response.status, 400);
  assert.equal(db.updates.length, 0);
});

test('update rejects a non-http(s) avatar link', async () => {
  const db = fakeDb({ user: USER });
  const request = requestWithCookie({ displayName: 'Marc', avatarUrl: 'javascript:alert(1)' });
  const response = await update(request, { ...env, DB: db });
  assert.equal(response.status, 400);
  assert.equal(db.updates.length, 0);
});

test('update persists name, bio and avatar, and returns the updated profile', async () => {
  const db = fakeDb({ user: USER });
  const request = requestWithCookie({
    displayName: '  Marc  ',
    bio: 'Building a screen-time app.',
    avatarUrl: 'https://example.com/me.jpg',
  });
  const response = await update(request, { ...env, DB: db });
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.user.displayName, 'Marc');
  assert.equal(body.user.bio, 'Building a screen-time app.');
  assert.equal(body.user.avatarUrl, 'https://example.com/me.jpg');

  assert.equal(db.updates.length, 1);
  assert.deepEqual(db.updates[0], ['Marc', 'Building a screen-time app.', 'https://example.com/me.jpg', 'user1']);
});

test('update clears the avatar when none is supplied', async () => {
  const db = fakeDb({ user: { ...USER, avatar_url: 'https://example.com/old.jpg' } });
  const request = requestWithCookie({ displayName: 'Marc', bio: '' });
  const response = await update(request, { ...env, DB: db });
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.user.avatarUrl, null);
  assert.equal(db.updates[0][2], null);
});

test('stats rejects an unauthenticated caller', async () => {
  const db = fakeDb({ user: null });
  const request = new Request('https://relay.example/profile/stats');
  const response = await stats(request, { ...env, DB: db });
  assert.equal(response.status, 401);
});

test('stats reports "too new" reliability below the resolved-session floor', async () => {
  const db = fakeDb({
    user: USER,
    reliabilityRow: { completed_count: 1, resolved_count: 1, avg_response_hours: null, contribution_count: 0 },
  });
  const request = new Request('https://relay.example/profile/stats', { headers: { cookie: 'lp_session=tok1' } });
  const response = await stats(request, { ...env, DB: db });
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.reliability.isNew, true);
  assert.equal(body.contribution, 0);
});

test('stats reports a real completion rate once past the floor', async () => {
  const db = fakeDb({
    user: USER,
    reliabilityRow: { completed_count: 4, resolved_count: 5, avg_response_hours: 3.2, contribution_count: 2 },
  });
  const request = new Request('https://relay.example/profile/stats', { headers: { cookie: 'lp_session=tok1' } });
  const response = await stats(request, { ...env, DB: db });
  const body = await response.json();
  assert.equal(body.reliability.isNew, false);
  assert.equal(body.reliability.completionRate, 80);
  assert.equal(body.contribution, 2);
});
