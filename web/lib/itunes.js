/**
 * Public App Store catalogue client for the browser.
 *
 * The endpoint answers with `access-control-allow-origin: *`, which is the only
 * reason the market tools can run here at all — the page calls Apple directly
 * and no server of ours ever sees a request.
 *
 * It is still somebody else's free service. This client is as polite from the
 * browser as the Python one is from a terminal: responses are cached, requests
 * are spaced, and nothing is fetched twice within a session.
 */

export const SEARCH_URL = 'https://itunes.apple.com/search';
export const LOOKUP_URL = 'https://itunes.apple.com/lookup';

/**
 * The screenshot relay's URL, once you have deployed `worker/` — see its
 * README. `null` disables the fallback entirely: the page then behaves
 * exactly as it did before, reporting withheld screenshots as "not exposed"
 * rather than fetching them from anywhere.
 *
 * This is the one request this page ever sends anywhere other than Apple.
 * It carries only a track id and a country code, both already public — set
 * this only once you have read `worker/README.md` and are comfortable with
 * what it does.
 */
export const SCREENSHOT_RELAY_URL = 'https://launchpilot-screenshot-relay.kaizenapp-contact.workers.dev';

/** Apple publishes no rate limit; ~20/minute is the understood ceiling. */
export const MIN_REQUEST_INTERVAL_MS = 1200;

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const CACHE_PREFIX = 'launchpilot:itunes:';

/** Page sizes to fall back through when the full response cannot be fetched. */
const FALLBACK_LIMITS = [150, 100, 50];

export class MarketDataError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Session-scoped response cache.
 *
 * sessionStorage rather than localStorage: this is other people's catalogue
 * data, useful for the length of a working session and stale by tomorrow.
 * Keeping it out of long-term storage also means closing the tab leaves
 * nothing behind.
 */
class ResponseCache {
  constructor(storage = globalThis.sessionStorage) {
    this.storage = storage;
  }

  get(key) {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(CACHE_PREFIX + key);
      if (!raw) return null;
      const { at, payload } = JSON.parse(raw);
      if (Date.now() - at > CACHE_TTL_MS) return null;
      return payload;
    } catch {
      return null;
    }
  }

  set(key, payload) {
    if (!this.storage) return;
    try {
      this.storage.setItem(CACHE_PREFIX + key, JSON.stringify({ at: Date.now(), payload }));
    } catch {
      // Quota exceeded, or storage disabled. A cache that cannot write is a
      // slow cache, not a broken program — drop the oldest entries and move on.
      this.evictOldest();
    }
  }

  evictOldest() {
    if (!this.storage) return;
    try {
      const keys = Object.keys(this.storage).filter((k) => k.startsWith(CACHE_PREFIX));
      for (const key of keys.slice(0, Math.ceil(keys.length / 2))) {
        this.storage.removeItem(key);
      }
    } catch {
      /* nothing further to try */
    }
  }

  clear() {
    if (!this.storage) return;
    try {
      for (const key of Object.keys(this.storage)) {
        if (key.startsWith(CACHE_PREFIX)) this.storage.removeItem(key);
      }
    } catch {
      /* nothing further to try */
    }
  }
}

export class ITunesClient {
  constructor({
    cache = new ResponseCache(),
    minInterval = MIN_REQUEST_INTERVAL_MS,
    fetchImpl,
    screenshotRelayUrl = SCREENSHOT_RELAY_URL,
  } = {}) {
    this.cache = cache;
    this.minInterval = minInterval;
    this.fetchImpl = fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.screenshotRelayUrl = screenshotRelayUrl;
    this.lastRequestAt = null;
  }

  async throttle() {
    if (this.lastRequestAt === null) return;
    const remaining = this.minInterval - (Date.now() - this.lastRequestAt);
    if (remaining > 0) await sleep(remaining);
  }

  async get(url, params, { subject = 'request' } = {}) {
    const query = new URLSearchParams(params).toString();
    const key = `${url}?${query}`;

    const cached = this.cache?.get(key);
    if (cached) return cached;

    await this.throttle();

    let response;
    try {
      response = await this.fetchImpl(`${url}?${query}`);
    } catch (err) {
      throw new MarketDataError(
        `Could not reach the App Store catalogue: ${err.message}. ` +
          'Check your connection — this page talks to Apple directly.',
      );
    } finally {
      this.lastRequestAt = Date.now();
    }

    if (!response.ok) {
      throw new MarketDataError(
        `The App Store catalogue returned ${response.status} for "${subject}". ` +
          'This endpoint rate-limits; wait a minute and try again.',
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      // The endpoint answers throttled requests with a non-JSON body and a 200.
      throw new MarketDataError(
        `The App Store catalogue returned an unreadable response for "${subject}". ` +
          'This usually means rate limiting; wait a minute and try again.',
      );
    }

    this.cache?.set(key, payload);
    return payload;
  }

  /**
   * Search, falling back to a smaller page if the full one cannot be fetched.
   *
   * A 200-result response is around 1.5 MB — the endpoint returns every field
   * it has, including full descriptions and device lists, with no way to ask
   * for less. That is fine on a desktop connection and not fine on a phone, a
   * throttled network, or behind a proxy that caps response bodies.
   *
   * Rather than quietly lowering the limit for everyone — which would change
   * the competitive-depth score and silently break parity with the CLI — the
   * full page is attempted first and the fallback is *reported*, so a reduced
   * sample is visible in the output instead of being mistaken for a thinner
   * market.
   */
  async search(term, { country = 'us', limit = 200 } = {}) {
    const attempts = [limit, ...FALLBACK_LIMITS.filter((l) => l < limit)];
    let lastError = null;

    for (const attempt of attempts) {
      try {
        const payload = await this.get(
          SEARCH_URL,
          { term, country: country.toLowerCase(), entity: 'software', limit: String(attempt) },
          { subject: term },
        );
        return {
          resultCount: payload.resultCount ?? 0,
          results: payload.results ?? [],
          limitUsed: attempt,
          limitRequested: limit,
          reduced: attempt < limit,
        };
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  /**
   * Fetch one app by numeric App Store id or by bundle id.
   *
   * `country` is always sent now. Apple's lookup endpoint currently answers
   * `?id=X` alone with no CORS headers at all — the browser blocks the
   * response and the request fails with an opaque "Failed to fetch" — while
   * `?id=X&country=us` answers with `access-control-allow-origin: *`. That is
   * the reverse of what this endpoint used to do, so dropping the parameter
   * for numeric ids (as this client once did) now breaks every lookup by id.
   */
  async lookup(appId, { country = 'us' } = {}) {
    const isNumericId = /^\d+$/.test(appId);
    const params = isNumericId
      ? { id: appId, country: country.toLowerCase() }
      : { bundleId: appId, country: country.toLowerCase() };

    const payload = await this.get(LOOKUP_URL, params, { subject: appId });
    return payload.results?.[0] ?? null;
  }

  /**
   * Recover screenshots via the relay when the catalogue withheld them.
   *
   * Returns `null` when the relay is not configured, unreachable, or found
   * nothing — every case degrades to "not exposed", never an error, since a
   * developer whose relay is down should see the same page they saw before
   * one existed, not a broken tool.
   */
  async fetchPageScreenshots(trackId, { country = 'us' } = {}) {
    if (!this.screenshotRelayUrl) return null;

    const key = `${this.screenshotRelayUrl}/screenshots?id=${trackId}&country=${country.toLowerCase()}`;
    const cached = this.cache?.get(key);
    if (cached) return cached;

    const query = new URLSearchParams({ id: String(trackId), country: country.toLowerCase() });
    let response;
    try {
      response = await this.fetchImpl(`${this.screenshotRelayUrl}/screenshots?${query}`);
    } catch {
      return null;
    }
    if (!response.ok) return null;

    let payload;
    try {
      payload = await response.json();
    } catch {
      return null;
    }

    const iphone = Array.isArray(payload?.iphone) ? payload.iphone : [];
    const ipad = Array.isArray(payload?.ipad) ? payload.ipad : [];
    if (!iphone.length && !ipad.length) return null;

    const result = { iphone, ipad };
    this.cache?.set(key, result);
    return result;
  }
}

export { ResponseCache };
