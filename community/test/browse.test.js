import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveSort } from '../src/routes/listings.js';
import { resolveSort as resolveBoardSort } from '../src/routes/leaderboard.js';

test('each known sort maps to its own SQL fragment', () => {
  const newest = resolveSort('newest');
  const contributors = resolveSort('contributors');
  const emptiest = resolveSort('emptiest');

  assert.notEqual(contributors, newest);
  assert.notEqual(emptiest, newest);
  assert.match(contributors, /owner_contribution_count DESC/);
  assert.match(emptiest, /slots_filled ASC/);
});

test('an unknown sort falls back to the default rather than reaching SQL', () => {
  // The fallback is the security property: whatever arrives on the query
  // string, the fragment spliced into the statement is one this module wrote.
  const injections = [
    "l.created_at; DROP TABLE listings--",
    '1=1 UNION SELECT * FROM users',
    'owner_contribution_count DESC',
    '',
    'NEWEST',
    '__proto__',
    'constructor',
    'toString',
  ];
  for (const attempt of injections) {
    assert.equal(resolveSort(attempt), resolveSort('newest'), `leaked for: ${attempt}`);
  }
});

test('a non-string sort is never trusted', () => {
  for (const value of [null, undefined, 42, {}, ['contributors']]) {
    assert.equal(resolveSort(value), resolveSort('newest'));
  }
});

test('the leaderboard sort safelist holds the same line', () => {
  // Same property, separate table: a second endpoint splicing a sort
  // fragment into SQL needs its own guard, not the listings one's reputation.
  assert.notEqual(resolveBoardSort('tests'), resolveBoardSort('apps'));
  assert.match(resolveBoardSort('tests'), /completed_count DESC/);
  assert.match(resolveBoardSort('apps'), /apps_helped DESC/);
  // Tokens are one-per-completed-test, so ranking by them would just be a
  // third spelling of `tests` — it must not be a sort the API accepts.
  assert.equal(resolveBoardSort('tokens'), resolveBoardSort('tests'));

  for (const attempt of [
    'completed_count DESC; DROP TABLE users--',
    '1=1',
    '',
    'TOKENS',
    '__proto__',
    'toString',
    null,
    undefined,
    42,
    ['tests'],
  ]) {
    assert.equal(resolveBoardSort(attempt), resolveBoardSort('tests'), `leaked for: ${attempt}`);
  }
});
