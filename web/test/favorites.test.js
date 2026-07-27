import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FavoritesStore, onFavoritesChange } from '../lib/favorites.js';

function fakeStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}

const APP_A = { trackId: 1, bundleId: 'com.a', name: 'A', seller: 'Dev A', artwork: 'a.png', country: 'us' };
const APP_B = { trackId: 2, bundleId: 'com.b', name: 'B', seller: 'Dev B', artwork: 'b.png', country: 'fr' };

test('a new store starts empty', () => {
  assert.deepEqual(new FavoritesStore(fakeStorage()).list(), []);
});

test('adding an app makes it a favorite, most recent first', () => {
  const store = new FavoritesStore(fakeStorage());
  store.add(APP_A);
  store.add(APP_B);
  assert.equal(store.has(APP_A.trackId), true);
  assert.deepEqual(store.list().map((a) => a.trackId), [2, 1]);
});

test('adding the same app twice replaces it rather than duplicating', () => {
  const store = new FavoritesStore(fakeStorage());
  store.add(APP_A);
  store.add({ ...APP_A, name: 'A renamed' });
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].name, 'A renamed');
});

test('removing drops it from the list', () => {
  const store = new FavoritesStore(fakeStorage());
  store.add(APP_A);
  store.remove(APP_A.trackId);
  assert.equal(store.has(APP_A.trackId), false);
  assert.deepEqual(store.list(), []);
});

test('toggle adds when absent and removes when present', () => {
  const store = new FavoritesStore(fakeStorage());
  assert.equal(store.toggle(APP_A), true);
  assert.equal(store.has(APP_A.trackId), true);
  assert.equal(store.toggle(APP_A), false);
  assert.equal(store.has(APP_A.trackId), false);
});

test('has and remove compare ids across string and number consistently', () => {
  const store = new FavoritesStore(fakeStorage());
  store.add(APP_A);
  assert.equal(store.has(String(APP_A.trackId)), true);
  store.remove(String(APP_A.trackId));
  assert.equal(store.has(APP_A.trackId), false);
});

test('a corrupt entry degrades to an empty list rather than throwing', () => {
  const storage = fakeStorage();
  storage.setItem('launchpilot:favorites', '{ not json');
  assert.deepEqual(new FavoritesStore(storage).list(), []);
});

test('a non-array entry degrades to an empty list', () => {
  const storage = fakeStorage();
  storage.setItem('launchpilot:favorites', JSON.stringify({ not: 'a list' }));
  assert.deepEqual(new FavoritesStore(storage).list(), []);
});

test('no storage available degrades to an empty, silently no-op store', () => {
  const store = new FavoritesStore(null);
  assert.deepEqual(store.list(), []);
  assert.doesNotThrow(() => store.add(APP_A));
});

test('an unwritable storage does not throw', () => {
  const storage = {
    getItem: () => null,
    setItem: () => {
      throw new Error('quota exceeded');
    },
    removeItem: () => {},
  };
  const store = new FavoritesStore(storage);
  assert.doesNotThrow(() => store.add(APP_A));
});

test('onFavoritesChange notifies subscribers after every mutation', () => {
  const store = new FavoritesStore(fakeStorage());
  let calls = 0;
  const unsubscribe = onFavoritesChange(() => {
    calls += 1;
  });
  store.add(APP_A);
  store.remove(APP_A.trackId);
  unsubscribe();
  store.add(APP_A);
  assert.equal(calls, 2);
});
