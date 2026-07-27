/**
 * Favorite apps: a short list you can jump back to from anywhere, unlike the
 * single "current app" Overview remembers for prefilling the other tools.
 *
 * Stored the same shape Overview already remembers (`{ trackId, bundleId,
 * name, seller, artwork, country }`), so a favorite can be handed straight to
 * `loadApp` without translation.
 */

const STORAGE_KEY = 'launchpilot:favorites';

const listeners = new Set();

function notify() {
  for (const fn of listeners) fn();
}

/** Called whenever the favorites list changes, from any store instance. */
export function onFavoritesChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export class FavoritesStore {
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

  has(trackId) {
    return this.list().some((a) => String(a.trackId) === String(trackId));
  }

  add(entry) {
    const rest = this.list().filter((a) => String(a.trackId) !== String(entry.trackId));
    this._write([entry, ...rest]);
  }

  remove(trackId) {
    this._write(this.list().filter((a) => String(a.trackId) !== String(trackId)));
  }

  /** Adds if absent, removes if present. Returns the new favorite state. */
  toggle(entry) {
    const nowFavorite = !this.has(entry.trackId);
    if (nowFavorite) this.add(entry);
    else this.remove(entry.trackId);
    return nowFavorite;
  }

  _write(list) {
    if (this.storage) {
      try {
        this.storage.setItem(STORAGE_KEY, JSON.stringify(list));
      } catch {
        /* quota exceeded or storage disabled; favorites just will not persist */
      }
    }
    notify();
  }
}

/** The one instance the app actually uses; tests build their own with a fake storage. */
export const favorites = new FavoritesStore();
