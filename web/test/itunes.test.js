/**
 * The screenshot relay fallback, from the browser side.
 *
 * The relay itself (worker/) is a separate deployable and is not exercised
 * here — this only checks that `ITunesClient` calls it correctly and degrades
 * to `null` on every kind of failure, since a developer whose relay is down
 * or unconfigured must see the same page as one who never deployed it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ITunesClient, ResponseCache } from '../lib/itunes.js';

/** A storage fake whose stored keys are real own properties, so
 * `Object.keys()` sees them the way it does on a real Storage object. */
function fakeStorage() {
  return Object.create({
    getItem(k) {
      return k in this ? this[k] : null;
    },
    setItem(k, v) {
      this[k] = String(v);
    },
    removeItem(k) {
      delete this[k];
    },
  });
}

const RELAY = 'https://relay.example';

function client({ fetchImpl, screenshotRelayUrl = RELAY, cache } = {}) {
  return new ITunesClient({
    fetchImpl,
    screenshotRelayUrl,
    cache: cache ?? new ResponseCache(fakeStorage()),
  });
}

function okResponse(body) {
  return { ok: true, json: async () => body };
}

test('returns null immediately when no relay is configured', async () => {
  let called = false;
  const c = client({
    screenshotRelayUrl: null,
    fetchImpl: async () => {
      called = true;
      return okResponse({ iphone: [], ipad: [] });
    },
  });
  assert.equal(await c.fetchPageScreenshots(123), null);
  assert.equal(called, false);
});

test('returns the screenshots the relay finds', async () => {
  const c = client({
    fetchImpl: async () => okResponse({ iphone: ['a.jpg', 'b.jpg'], ipad: ['c.jpg'] }),
  });
  assert.deepEqual(await c.fetchPageScreenshots(123), {
    iphone: ['a.jpg', 'b.jpg'],
    ipad: ['c.jpg'],
  });
});

test('calls the relay with the id and country as query params', async () => {
  let seenUrl;
  const c = client({
    fetchImpl: async (url) => {
      seenUrl = url;
      return okResponse({ iphone: ['a.jpg'], ipad: [] });
    },
  });
  await c.fetchPageScreenshots(6768688178, { country: 'FR' });
  const url = new URL(seenUrl);
  assert.equal(url.origin + url.pathname, `${RELAY}/screenshots`);
  assert.equal(url.searchParams.get('id'), '6768688178');
  assert.equal(url.searchParams.get('country'), 'fr');
});

test('returns null when the relay finds nothing', async () => {
  const c = client({ fetchImpl: async () => okResponse({ iphone: [], ipad: [] }) });
  assert.equal(await c.fetchPageScreenshots(123), null);
});

test('returns null on a non-ok response', async () => {
  const c = client({ fetchImpl: async () => ({ ok: false, json: async () => ({}) }) });
  assert.equal(await c.fetchPageScreenshots(123), null);
});

test('returns null when the relay is unreachable', async () => {
  const c = client({
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });
  assert.equal(await c.fetchPageScreenshots(123), null);
});

test('returns null on an unreadable response body', async () => {
  const c = client({
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        throw new Error('not json');
      },
    }),
  });
  assert.equal(await c.fetchPageScreenshots(123), null);
});

test('a successful lookup is cached and not refetched', async () => {
  let calls = 0;
  const c = client({
    fetchImpl: async () => {
      calls += 1;
      return okResponse({ iphone: ['a.jpg'], ipad: [] });
    },
  });
  await c.fetchPageScreenshots(123, { country: 'us' });
  await c.fetchPageScreenshots(123, { country: 'us' });
  assert.equal(calls, 1);
});

test('different ids are cached separately', async () => {
  let calls = 0;
  const c = client({
    fetchImpl: async () => {
      calls += 1;
      return okResponse({ iphone: ['a.jpg'], ipad: [] });
    },
  });
  await c.fetchPageScreenshots(1, { country: 'us' });
  await c.fetchPageScreenshots(2, { country: 'us' });
  assert.equal(calls, 2);
});
