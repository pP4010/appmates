/**
 * Client for the AppMates Community backend.
 *
 * This is the one part of the app that needs an account: matching a real
 * developer with a real tester means knowing who's who, which the rest of
 * this tool deliberately never needs. Every request carries the session
 * cookie (`credentials: 'include'`) rather than a token in JS, so nothing
 * here ever touches localStorage/sessionStorage with anything sensitive.
 */

export class CommunityError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * The community Worker's URL, once you have deployed `community/` — see its
 * README. `null` disables the whole feature: the nav item stays hidden and
 * nothing here is ever called.
 */
export const COMMUNITY_API_URL = 'https://launchpilot-community.kaizenapp-contact.workers.dev';

export class CommunityClient {
  constructor({ fetchImpl, baseUrl = COMMUNITY_API_URL } = {}) {
    this.fetchImpl = fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.baseUrl = baseUrl;
  }

  get configured() {
    return Boolean(this.baseUrl);
  }

  async _request(path, { method = 'GET', body } = {}) {
    if (!this.baseUrl) {
      throw new CommunityError('Community features are not configured on this deployment yet.');
    }

    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        credentials: 'include',
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new CommunityError(`Could not reach the community service: ${err.message}`);
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      /* a handful of endpoints (e.g. the verify redirect) aren't JSON */
    }

    if (!response.ok) {
      throw new CommunityError(payload?.error || `Request failed (${response.status})`, response.status);
    }
    return payload;
  }

  requestLink(email) {
    return this._request('/auth/request-link', { method: 'POST', body: { email } });
  }

  /** Resolves to the signed-in user, or `null` if nobody is signed in —
   * never throws for the ordinary "not signed in" case. */
  async me() {
    try {
      const data = await this._request('/auth/me');
      return data.user;
    } catch (err) {
      if (err instanceof CommunityError && err.status === 401) return null;
      throw err;
    }
  }

  logout() {
    return this._request('/auth/logout', { method: 'POST' });
  }

  connectApp(app) {
    return this._request('/apps', { method: 'POST', body: app });
  }

  myApps() {
    return this._request('/apps/mine').then((d) => d.apps);
  }

  createListing(listing) {
    return this._request('/listings', { method: 'POST', body: listing }).then((d) => d.listing);
  }

  browseListings(kind, sort) {
    const params = new URLSearchParams();
    if (kind) params.set('kind', kind);
    if (sort) params.set('sort', sort);
    const query = params.toString();
    return this._request(`/listings${query ? `?${query}` : ''}`).then((d) => d.listings);
  }

  myListings() {
    return this._request('/listings/mine').then((d) => d.listings);
  }

  listingDetail(id) {
    return this._request(`/listings/${id}`).then((d) => d.listing);
  }

  closeListing(id) {
    return this._request(`/listings/${id}/close`, { method: 'POST' });
  }

  featureListing(id, days) {
    return this._request(`/listings/${id}/feature`, { method: 'POST', body: { days } });
  }

  /** Asks to join a `testing` listing — a short pitch, not an instant join.
   * `email`/`name` are only needed when nobody is signed in yet; the
   * response says whether a sign-in link was sent so the caller can prompt
   * "check your inbox" instead of assuming the request is already theirs
   * to track. */
  requestToJoin(id, { email, name, message } = {}) {
    return this._request(`/listings/${id}/request`, {
      method: 'POST',
      body: { email, name, message },
    });
  }

  listingSessions(id) {
    return this._request(`/listings/${id}/sessions`).then((d) => d.sessions);
  }

  acceptSession(id) {
    return this._request(`/test-sessions/${id}/accept`, { method: 'POST' });
  }

  declineSession(id) {
    return this._request(`/test-sessions/${id}/decline`, { method: 'POST' });
  }

  mySessions() {
    return this._request('/test-sessions/mine').then((d) => d.sessions);
  }

  submitSession(id, { feedback, bugFound, wouldUseAgain }) {
    return this._request(`/test-sessions/${id}/submit`, {
      method: 'POST',
      body: { feedback, bugFound, wouldUseAgain },
    });
  }

  completeSession(id) {
    return this._request(`/test-sessions/${id}/complete`, { method: 'POST' });
  }

  /** The message thread on one test session, oldest first — everything
   * exchanged after the opening pitch, in either direction. */
  sessionMessages(id) {
    return this._request(`/test-sessions/${id}/messages`).then((d) => d.messages);
  }

  sendSessionMessage(id, body) {
    return this._request(`/test-sessions/${id}/messages`, { method: 'POST', body: { body } }).then(
      (d) => d.message,
    );
  }

  /** Submits the landing page's "Feature your app here" dialog. No sign-in
   * required — `requesterName`/`email` are who to reply to, not an account. */
  submitPromoRequest({ trackId, name, genre, artworkUrl, storeUrl, color, message, requesterName, email }) {
    return this._request('/promo/requests', {
      method: 'POST',
      body: {
        trackId,
        appName: name,
        appGenre: genre,
        artworkUrl,
        storeUrl,
        color,
        message,
        requesterName,
        email,
      },
    }).then((d) => d.request);
  }

  /** Every "Feature your app here" submission, admin-only — see
   * `views/admin.js`. Throws a `CommunityError` with `status === 403` for
   * anyone signed in but not on the admin allowlist. */
  adminListPromoRequests() {
    return this._request('/promo/requests').then((d) => d.requests);
  }

  adminReviewPromoRequest(id, action) {
    return this._request(`/promo/requests/${id}/${action}`, { method: 'POST' }).then((d) => d.request);
  }

  /** Public: the approved promo requests a landing page can render as
   * promoted rail cards, shaped exactly like `RAIL_LEFT`/`RAIL_RIGHT` in
   * `landing-demo.js` so `renderRails` can merge these in directly. */
  featuredPromoSlots() {
    return this._request('/promo/featured').then((d) => d.slots);
  }

  tokens() {
    return this._request('/tokens/me');
  }

  /** Resolves to `{ windowDays, testers, contributors }` — two boards over
   * the same trailing window, the second narrowed to contributors who also
   * have something open for others to test. `sort` is `tokens` (default) or
   * `tests`; `limit` raises how many rows come back, capped server-side. */
  leaderboard({ windowDays, sort, limit } = {}) {
    const params = new URLSearchParams();
    if (windowDays) params.set('window', windowDays);
    if (sort) params.set('sort', sort);
    if (limit) params.set('limit', limit);
    const query = params.toString();
    return this._request(`/leaderboard${query ? `?${query}` : ''}`);
  }
}
