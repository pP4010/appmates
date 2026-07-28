/**
 * Client for the LaunchPilot Community backend.
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
export const COMMUNITY_API_URL = null;

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

  browseListings(kind) {
    const query = kind ? `?kind=${encodeURIComponent(kind)}` : '';
    return this._request(`/listings${query}`).then((d) => d.listings);
  }

  myListings() {
    return this._request('/listings/mine').then((d) => d.listings);
  }

  closeListing(id) {
    return this._request(`/listings/${id}/close`, { method: 'POST' });
  }

  featureListing(id, days) {
    return this._request(`/listings/${id}/feature`, { method: 'POST', body: { days } });
  }

  joinListing(id) {
    return this._request(`/listings/${id}/join`, { method: 'POST' });
  }

  listingSessions(id) {
    return this._request(`/listings/${id}/sessions`).then((d) => d.sessions);
  }

  mySessions() {
    return this._request('/test-sessions/mine').then((d) => d.sessions);
  }

  submitSession(id, feedback) {
    return this._request(`/test-sessions/${id}/submit`, { method: 'POST', body: { feedback } });
  }

  completeSession(id) {
    return this._request(`/test-sessions/${id}/complete`, { method: 'POST' });
  }

  tokens() {
    return this._request('/tokens/me');
  }
}
