/**
 * Testing campaigns you're running — one entry per (app, store) pair.
 *
 * Unlike `favorites.js` (which apps you care about) this is what you're
 * *doing* about testing them: an invite link, who's opted in, and — for
 * Google — the streak the 12-testers-for-14-days gate actually needs.
 * Stored the same place everything else client-only lives: this browser,
 * nothing sent anywhere.
 */

const STORAGE_KEY = 'appmates:tests';

export class TestsStore {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
  }

  list() {
    if (!this.storage) return [];
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  get(id) {
    return this.list().find((t) => t.id === id) ?? null;
  }

  /** Upserts by id — a missing id is treated as a new test. */
  save(test) {
    const entry = { ...test, id: test.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
    const rest = this.list().filter((t) => t.id !== entry.id);
    this._write([entry, ...rest]);
    return entry;
  }

  remove(id) {
    this._write(this.list().filter((t) => t.id !== id));
  }

  _write(list) {
    if (this.storage) {
      try {
        this.storage.setItem(STORAGE_KEY, JSON.stringify(list));
      } catch {
        /* quota exceeded or storage disabled; the test still works this session */
      }
    }
  }
}

export const testsStore = new TestsStore();
