import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lookup } from '../src/routes/itunes.js';

const env = { APP_ORIGIN: 'https://example.com' };
const ctx = { waitUntil: () => {} };

function stubCache() {
  const original = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  return () => {
    globalThis.caches = original;
  };
}

function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return handler(url);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('lookup by bundleId forwards bundleId to Apple, not a rejected numeric id', async () => {
  const restoreCache = stubCache();
  const { calls, restore } = stubFetch(async () => new Response(JSON.stringify({ resultCount: 1, results: [{ trackId: 123 }] })));
  try {
    const request = new Request('https://relay.example/itunes/lookup?bundleId=com.paolo.kaizen&country=us');
    const response = await lookup(request, env, ctx);
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /bundleId=com\.paolo\.kaizen/);
    assert.doesNotMatch(calls[0], /[?&]id=/);
  } finally {
    restore();
    restoreCache();
  }
});

test('lookup by numeric id still works', async () => {
  const restoreCache = stubCache();
  const { calls, restore } = stubFetch(async () => new Response(JSON.stringify({ resultCount: 1, results: [{ trackId: 123456 }] })));
  try {
    const request = new Request('https://relay.example/itunes/lookup?id=123456&country=us');
    const response = await lookup(request, env, ctx);
    assert.equal(response.status, 200);
    assert.match(calls[0], /[?&]id=123456/);
  } finally {
    restore();
    restoreCache();
  }
});

test('lookup rejects a request with neither id nor bundleId', async () => {
  const restoreCache = stubCache();
  try {
    const request = new Request('https://relay.example/itunes/lookup?country=us');
    const response = await lookup(request, env, ctx);
    assert.equal(response.status, 400);
  } finally {
    restoreCache();
  }
});
