import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isValidEmail } from '../src/lib/auth.js';
import { isHttpUrl } from '../src/lib/validate.js';

test('accepts ordinary email addresses', () => {
  assert.equal(isValidEmail('dev@example.com'), true);
  assert.equal(isValidEmail('first.last+tag@sub.example.co'), true);
});

test('rejects malformed email addresses', () => {
  assert.equal(isValidEmail('not-an-email'), false);
  assert.equal(isValidEmail('missing@domain'), false);
  assert.equal(isValidEmail('@example.com'), false);
  assert.equal(isValidEmail(''), false);
  assert.equal(isValidEmail(null), false);
  assert.equal(isValidEmail(undefined), false);
  assert.equal(isValidEmail(123), false);
});

test('rejects an email past the practical length limit', () => {
  const long = `${'a'.repeat(250)}@example.com`;
  assert.equal(isValidEmail(long), false);
});

test('accepts http and https links', () => {
  assert.equal(isHttpUrl('https://testflight.apple.com/join/abc123'), true);
  assert.equal(isHttpUrl('http://play.google.com/apps/testing/com.example'), true);
});

test('rejects non-http(s) schemes and garbage', () => {
  assert.equal(isHttpUrl('javascript:alert(1)'), false);
  assert.equal(isHttpUrl('ftp://example.com/file'), false);
  assert.equal(isHttpUrl('not a url'), false);
  assert.equal(isHttpUrl(''), false);
});
