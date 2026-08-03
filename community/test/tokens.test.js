import { test } from 'node:test';
import assert from 'node:assert/strict';

import { awardTokens, spendTokens, InsufficientTokensError } from '../src/lib/tokens.js';

/** A minimal D1 fake: `prepare().bind()` returns an opaque statement object
 * carrying its own SQL/args, and `batch()` records exactly what it was
 * given so a test can assert every statement — including a caller's
 * `extraStatements` — landed in the same atomic call. */
function fakeDb({ balance = 0 } = {}) {
  const batches = [];
  return {
    batches,
    prepare(sql) {
      return {
        sql,
        bind(...args) {
          return { sql, args };
        },
      };
    },
    async batch(statements) {
      batches.push(statements);
      return statements.map(() => ({ success: true }));
    },
    first: async () => ({ balance }),
  };
}

test('awardTokens lands the caller-supplied statement in the same batch as the ledger write', async () => {
  const db = fakeDb();
  const env = { DB: db };
  const extra = db.prepare('UPDATE test_sessions SET status = ? WHERE id = ?').bind('completed', 'sess1');

  await awardTokens(env, 'user1', 5, 'earned_test', 'sess1', [extra]);

  assert.equal(db.batches.length, 1);
  assert.equal(db.batches[0].length, 3);
  assert.equal(db.batches[0][2], extra);
});

test('awardTokens with no extra statements still batches the ledger write atomically', async () => {
  const db = fakeDb();
  const env = { DB: db };

  await awardTokens(env, 'user1', 5, 'earned_test', 'sess1');

  assert.equal(db.batches.length, 1);
  assert.equal(db.batches[0].length, 2);
});

test('spendTokens lands the caller-supplied statement in the same batch as the deduction', async () => {
  const db = fakeDb({ balance: 100 });
  const env = { DB: db };
  db.prepare = ((original) => (sql) => {
    if (sql.startsWith('SELECT')) {
      return { bind: () => ({ first: async () => ({ balance: 100 }) }) };
    }
    return original(sql);
  })(db.prepare);

  const extra = { sql: 'UPDATE listings SET featured_until = ? WHERE id = ?', args: ['+3 days', 'listing1'] };
  await spendTokens(env, 'user1', 30, 'spent_feature', 'listing1', [extra]);

  assert.equal(db.batches.length, 1);
  assert.equal(db.batches[0].length, 3);
  assert.equal(db.batches[0][2], extra);
});

test('spendTokens rejects an insufficient balance before touching the batch', async () => {
  const db = fakeDb();
  const env = { DB: db };
  db.prepare = (sql) => {
    if (sql.startsWith('SELECT')) return { bind: () => ({ first: async () => ({ balance: 5 }) }) };
    return { bind: () => ({}) };
  };

  await assert.rejects(
    () => spendTokens(env, 'user1', 30, 'spent_feature', 'listing1', [{ sql: 'noop' }]),
    InsufficientTokensError,
  );
  assert.equal(db.batches.length, 0);
});
