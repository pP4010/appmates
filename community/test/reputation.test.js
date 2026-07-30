import { test } from 'node:test';
import assert from 'node:assert/strict';

import { builderReliability, publicDisplayName } from '../src/lib/reputation.js';
import { isValidMessage } from '../src/lib/validate.js';
import { MIN_RESOLVED_FOR_RELIABILITY } from '../src/lib/config.js';

test('a builder below the resolved-session floor shows as new, not a rate', () => {
  const rep = builderReliability({
    completedCount: 1,
    resolvedCount: MIN_RESOLVED_FOR_RELIABILITY - 1,
    avgResponseHours: 3,
  });
  assert.equal(rep.isNew, true);
  assert.equal(rep.completionRate, null);
  assert.equal(rep.avgResponseHours, null);
});

test('a builder at the floor gets a real completion rate', () => {
  const rep = builderReliability({
    completedCount: 2,
    resolvedCount: MIN_RESOLVED_FOR_RELIABILITY,
    avgResponseHours: 26.05,
  });
  assert.equal(rep.isNew, false);
  assert.equal(rep.completionRate, Math.round((2 / MIN_RESOLVED_FOR_RELIABILITY) * 100));
  assert.equal(rep.avgResponseHours, 26.1);
});

test('declines and abandons count against the rate, not just completions', () => {
  // 1 completed out of 4 resolved reads very differently from 1 out of 1.
  const rep = builderReliability({ completedCount: 1, resolvedCount: 4, avgResponseHours: null });
  assert.equal(rep.completionRate, 25);
  assert.equal(rep.avgResponseHours, null);
});

test('a tester without a display name is never shown by email', () => {
  const name = publicDisplayName({ displayName: null, id: 'abcdef123456' });
  assert.equal(name, 'Tester abcdef');
  assert.doesNotMatch(name, /@/);
});

test('a tester with a display name is shown as-is', () => {
  assert.equal(publicDisplayName({ displayName: '  Jae  ', id: 'abcdef123456' }), 'Jae');
});

test('request messages must clear the minimum length, trimmed', () => {
  assert.equal(isValidMessage('short', { min: 20, max: 1000 }), false);
  assert.equal(isValidMessage('   '.padEnd(25, ' '), { min: 20, max: 1000 }), false);
  assert.equal(
    isValidMessage('iPhone 15, iOS 18 — I test productivity apps weekly.', { min: 20, max: 1000 }),
    true,
  );
});

test('request messages are rejected past the max length', () => {
  assert.equal(isValidMessage('a'.repeat(1001), { min: 20, max: 1000 }), false);
  assert.equal(isValidMessage('a'.repeat(1000), { min: 20, max: 1000 }), true);
});

test('a non-string message is never valid', () => {
  assert.equal(isValidMessage(null, { min: 20, max: 1000 }), false);
  assert.equal(isValidMessage(undefined, { min: 20, max: 1000 }), false);
  assert.equal(isValidMessage(12345678901234567890, { min: 20, max: 1000 }), false);
});
