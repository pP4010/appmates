import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';

function stubCache() {
  const original = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  return () => {
    globalThis.caches = original;
  };
}

function stubFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => '<html></html>' });
  return () => {
    globalThis.fetch = original;
  };
}

const ctx = { waitUntil: () => {} };

test('a request is allowed through when no limiter binding is configured (local dev)', async () => {
  const restoreCache = stubCache();
  const restoreFetch = stubFetch();
  try {
    const request = new Request('https://relay.example/screenshots?id=123&country=us');
    const response = await worker.fetch(request, {}, ctx);
    assert.equal(response.status, 200);
  } finally {
    restoreCache();
    restoreFetch();
  }
});

test('a request is rejected with 429 once the per-IP limiter says no', async () => {
  const restoreCache = stubCache();
  const restoreFetch = stubFetch();
  try {
    const env = { SCREENSHOT_LIMITER: { limit: async () => ({ success: false }) } };
    const request = new Request('https://relay.example/screenshots?id=123&country=us', {
      headers: { 'cf-connecting-ip': '1.2.3.4' },
    });
    const response = await worker.fetch(request, env, ctx);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '60');
  } finally {
    restoreCache();
    restoreFetch();
  }
});

test('a request proceeds when the per-IP limiter says yes', async () => {
  const restoreCache = stubCache();
  const restoreFetch = stubFetch();
  try {
    const env = { SCREENSHOT_LIMITER: { limit: async () => ({ success: true }) } };
    const request = new Request('https://relay.example/screenshots?id=123&country=us');
    const response = await worker.fetch(request, env, ctx);
    assert.equal(response.status, 200);
  } finally {
    restoreCache();
    restoreFetch();
  }
});
