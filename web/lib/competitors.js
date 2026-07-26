/**
 * Competitors, screenshot conventions and shared vocabulary — the browser
 * counterpart of `core/services/competitor_analyzer`.
 *
 * Two honesty constraints carried over from the Python side:
 *
 * Screenshot availability is partial. Across a 55-app sample the catalogue
 * exposed iPhone screenshots for 47% of apps. Withheld apps are marked as such
 * rather than shown as having none, and they are excluded from the medians
 * instead of counted as zeros.
 *
 * A search position is not an App Store ranking. It is this endpoint's own
 * relevance ordering, which is a real signal but not what the App Store app
 * serves.
 */

import { tokenize, looksPlural, getAso } from './keywords.js';

export const DEFAULT_TOP_N = 10;

const SIZE_RE = /\/(\d+)x(\d+)[a-z]*\.(?:png|jpg|jpeg)$/i;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;

function stripUrls(text) {
  return text.replace(URL_RE, ' ').replace(EMAIL_RE, ' ');
}

/**
 * Describe a screenshot from its URL alone.
 *
 * The catalogue encodes the served size in the last path segment, so a whole
 * gallery can be described without fetching a single image.
 */
export function parseScreenshot(url, device) {
  const match = SIZE_RE.exec(url);
  const width = match ? Number(match[1]) : null;
  const height = match ? Number(match[2]) : null;
  return {
    url,
    device,
    width,
    height,
    isPortrait: width && height ? height >= width : null,
    /**
     * The CDN's suffixes are not interchangeable: `bb` fits inside a box and
     * requires both dimensions, so `300x0bb.png` is answered with a 400. `w`
     * constrains width only and accepts a zero height.
     */
    atSize(w, h = 0) {
      const base = url.slice(0, url.lastIndexOf('/'));
      if (!base) return url;
      return h ? `${base}/${w}x${h}bb.png` : `${base}/${w}x0w.png`;
    },
  };
}

function parseDate(value) {
  if (typeof value !== 'string' || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function competitorFromEntry(entry, position, today = new Date()) {
  if (typeof entry.trackId !== 'number' || typeof entry.trackName !== 'string') return null;

  const iphoneUrls = (entry.screenshotUrls ?? []).filter((u) => typeof u === 'string');
  const ipadUrls = (entry.ipadScreenshotUrls ?? []).filter((u) => typeof u === 'string');
  const screenshots = [
    ...iphoneUrls.map((u) => parseScreenshot(u, 'iphone')),
    ...ipadUrls.map((u) => parseScreenshot(u, 'ipad')),
  ];
  const updated = parseDate(entry.currentVersionReleaseDate);

  return {
    position,
    trackId: entry.trackId,
    name: entry.trackName,
    description: entry.description ?? '',
    seller: entry.sellerName || entry.artistName || 'unknown',
    ratingCount: Number(entry.userRatingCount ?? 0),
    rating: entry.averageUserRating ? Number(entry.averageUserRating) : null,
    price: Number(entry.price ?? 0),
    updated,
    daysSinceUpdate: updated ? Math.floor((today - updated) / 86_400_000) : null,
    artwork: entry.artworkUrl100 ?? entry.artworkUrl60 ?? null,
    storeUrl: entry.trackViewUrl ?? null,
    screenshots,
    screenshotsExposed: iphoneUrls.length > 0 || ipadUrls.length > 0,
    // Reported separately because the catalogue routinely returns one set and
    // not the other: an app can expose ten iPad screenshots and no iPhone ones,
    // where a single total would read as "ships ten phone screenshots".
    iphoneCount: iphoneUrls.length,
    ipadCount: ipadUrls.length,
  };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** What the field does with its screenshots, computed only from exposed apps. */
export function buildStrategy(apps) {
  const exposed = apps.filter((a) => a.screenshotsExposed);
  const missing = apps.filter((a) => !a.screenshotsExposed);
  const counts = exposed.map((a) => a.iphoneCount).filter((c) => c > 0);

  let portrait = 0;
  let landscape = 0;
  for (const app of exposed) {
    const orientations = app.screenshots
      .filter((s) => s.device === 'iphone' && s.isPortrait !== null)
      .map((s) => s.isPortrait);
    if (!orientations.length) continue;
    if (orientations.filter(Boolean).length * 2 >= orientations.length) portrait += 1;
    else landscape += 1;
  }

  const total = exposed.length + missing.length;
  return {
    appsSampled: exposed.length,
    appsMissing: missing.length,
    counts,
    medianCount: Math.round(median(counts) * 10) / 10,
    coveragePercent: total ? Math.round((1000 * exposed.length) / total) / 10 : 0,
    portraitApps: portrait,
    landscapeApps: landscape,
    ipadApps: exposed.filter((a) => a.ipadCount > 0).length,
    usesMaxSlots: counts.filter((c) => c >= 10).length,
    distribution: counts.reduce((acc, c) => ({ ...acc, [c]: (acc[c] ?? 0) + 1 }), {}),
  };
}

/**
 * The vocabulary a field of competitors agrees on.
 *
 * Only app names and descriptions are public — the store exposes neither
 * subtitles nor keyword fields — so this is a floor on what rivals target.
 *
 * Terms are counted once per app. Ranking by raw occurrences would let one
 * verbose description outvote the whole field.
 */
export function extractTerms(apps, { yourText = '', topN = 25, minApps = 2 } = {}) {
  const aso = getAso();
  const ignored = new Set([...aso.noise_words, ...aso.category_words, ...aso.prose_stopwords]);
  const keep = (w) => !ignored.has(w) && w.length > 2 && !/^\d+$/.test(w);

  // Sets of app indices, not counts: merging plural variants below is a union,
  // which summing counters cannot express.
  const inName = new Map();
  const inDescription = new Map();
  const add = (map, word, index) => {
    if (!map.has(word)) map.set(word, new Set());
    map.get(word).add(index);
  };

  apps.forEach((app, index) => {
    const nameWords = new Set(tokenize(app.name).filter(keep));
    const descWords = new Set(tokenize(stripUrls(app.description)).filter(keep));
    for (const w of nameWords) add(inName, w, index);
    for (const w of descWords) if (!nameWords.has(w)) add(inDescription, w, index);
  });

  mergePlurals(inName, inDescription);

  const yours = new Set(tokenize(yourText));
  const terms = new Set([...inName.keys(), ...inDescription.keys()]);

  const usages = [...terms]
    .map((term) => {
      const nameCount = inName.get(term)?.size ?? 0;
      const descCount = inDescription.get(term)?.size ?? 0;
      // A word in a 30-character name is a deliberate ASO decision; the same
      // word in paragraph four of a description may be incidental prose.
      const weighted = 4 * nameCount + descCount;
      return {
        term,
        appsInName: nameCount,
        appsInDescription: descCount,
        appsTotal: apps.length,
        inYourListing: yours.has(term) || [...yours].some((y) => looksPlural(y, term)),
        score: apps.length ? Math.round((1000 * weighted) / (5 * apps.length)) / 10 : 0,
      };
    })
    .filter((u) => u.appsInName + u.appsInDescription >= minApps);

  usages.sort((a, b) => b.score - a.score || b.appsInName - a.appsInName || a.term.localeCompare(b.term));
  return usages.slice(0, topN);
}

/** Fold "habits" into "habit" so one concept does not split its own signal. */
function mergePlurals(inName, inDescription) {
  const all = new Set([...inName.keys(), ...inDescription.keys()]);
  for (const plural of [...all].sort()) {
    for (const singular of [plural.slice(0, -1), plural.slice(0, -2)]) {
      if (all.has(singular) && looksPlural(plural, singular)) {
        for (const map of [inName, inDescription]) {
          if (map.has(plural)) {
            const target = map.get(singular) ?? new Set();
            for (const i of map.get(plural)) target.add(i);
            map.set(singular, target);
            map.delete(plural);
          }
        }
        break;
      }
    }
  }
}

export function analyseCompetitors(
  keyword,
  { country, resultCount, entries, topN = DEFAULT_TOP_N, yourText = '', today = new Date() },
) {
  const apps = [];
  for (const [index, entry] of entries.entries()) {
    const app = competitorFromEntry(entry, index + 1, today);
    if (app) apps.push(app);
    if (apps.length >= topN) break;
  }

  const strategy = apps.length ? buildStrategy(apps) : null;
  const notes = [];
  if (!apps.length) {
    // Single quotes to match Python's `{keyword!r}`, which the conformance
    // corpus records verbatim.
    notes.push(`No apps returned for '${keyword}'.`);
  } else if (strategy?.appsMissing) {
    notes.push(
      `The catalogue withheld screenshots for ${strategy.appsMissing} of ${apps.length} apps; ` +
        `the figures below come from the other ${strategy.appsSampled}.`,
    );
  }

  return {
    keyword,
    country: country.toUpperCase(),
    resultCount,
    apps,
    strategy,
    terms: extractTerms(apps, { yourText }),
    notes,
  };
}

// --- rank ----------------------------------------------------------------

const RANK_HISTORY_KEY = 'launchpilot:ranks';

/**
 * Position history kept in the browser.
 *
 * localStorage rather than sessionStorage: this is the user's own record of
 * their app's movement, and it is the whole point that it survives closing the
 * tab. Nothing leaves the machine.
 */
export class RankHistory {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
  }

  read() {
    try {
      return JSON.parse(this.storage?.getItem(RANK_HISTORY_KEY) ?? '[]');
    } catch {
      return [];
    }
  }

  latest(trackId, keyword, country) {
    const matches = this.read().filter(
      (r) => r.trackId === trackId && r.keyword === keyword && r.country === country,
    );
    return matches.length
      ? matches.reduce((best, r) => (r.date > best.date ? r : best))
      : null;
  }

  append(report) {
    const records = this.read();
    for (const position of report.positions) {
      records.push({
        date: report.checkedAt.slice(0, 10),
        trackId: report.trackId,
        country: report.country,
        keyword: position.keyword,
        position: position.position,
        searchedDepth: position.searchedDepth,
      });
    }
    try {
      this.storage?.setItem(RANK_HISTORY_KEY, JSON.stringify(records));
    } catch {
      /* storage full or disabled; the run still reports its current positions */
    }
  }

  clear() {
    try {
      this.storage?.removeItem(RANK_HISTORY_KEY);
    } catch {
      /* nothing to do */
    }
  }
}

export function findPosition(trackId, entries) {
  const index = entries.findIndex((e) => e.trackId === trackId);
  return index === -1 ? null : index + 1;
}

export async function checkRank(
  client,
  appId,
  keywords,
  { country = 'us', depth = 200, history = null, onProgress } = {},
) {
  const entry = await client.lookup(appId, { country });
  if (!entry) {
    throw new Error(
      `No app found for "${appId}" in the ${country.toUpperCase()} storefront. ` +
        'Use a numeric App Store id or a bundle id.',
    );
  }

  const trackId = entry.trackId;
  const positions = [];

  for (const [index, keyword] of keywords.entries()) {
    onProgress?.(keyword, index + 1, keywords.length);
    const { resultCount, results } = await client.search(keyword, { country, limit: depth });
    const position = findPosition(trackId, results);
    const previous = history?.latest(trackId, keyword, country.toUpperCase()) ?? null;

    positions.push({
      keyword,
      position,
      searchedDepth: results.length,
      resultCount,
      found: position !== null,
      previousPosition: previous?.position ?? null,
      previousDate: previous?.date ?? null,
      movement:
        position !== null && previous?.position != null ? previous.position - position : null,
    });
  }

  return {
    appName: entry.trackName ?? appId,
    trackId,
    artwork: entry.artworkUrl100 ?? null,
    country: country.toUpperCase(),
    checkedAt: new Date().toISOString(),
    positions,
    rankedFor: positions.filter((p) => p.found).length,
  };
}
