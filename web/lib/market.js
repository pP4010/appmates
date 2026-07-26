/**
 * Niche winnability — the browser counterpart of `core/services/market_analyzer`
 * and `market_scanner`.
 *
 * The scoring curves, weights and thresholds all come from the generated
 * specs.json, which is projected from the same `market.yaml` the CLI reads. Only
 * the rule logic exists twice, and the conformance suite holds the two together.
 *
 * As on the Python side, scoring is pure: it takes fetched entries, never a URL.
 */

export const LEADER_SAMPLE = 10;
export const DEFAULT_FETCH_LIMIT = 200;

let SPEC = null;
let STOREFRONTS = { default: [], names: {} };

export function loadMarketSpec(specs) {
  SPEC = specs.market ?? specs;
  STOREFRONTS = specs.storefronts ?? STOREFRONTS;
}

export function getMarketSpec() {
  if (!SPEC) throw new Error('loadMarketSpec() must be called before analysing');
  return SPEC;
}

export function defaultStorefronts() {
  return [...(STOREFRONTS.default ?? [])];
}

export function countryName(code) {
  return STOREFRONTS.names?.[code.toLowerCase()] ?? code.toUpperCase();
}

// --- helpers -------------------------------------------------------------

function parseDate(value) {
  if (typeof value !== 'string' || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function daysBetween(from, to) {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function normalise(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]+/g, ' ');
}

/**
 * Whether every word of the search term appears in the app name.
 *
 * Word-wise rather than substring, matching the Python side: "habit tracker"
 * matches "Tracker of Habits", but "hab" must not match "habit" or the
 * targeting signal inflates.
 */
export function keywordInName(keyword, name) {
  const haystack = new Set(normalise(name).split(/\s+/).filter(Boolean));
  const needles = normalise(keyword).split(/\s+/).filter(Boolean);
  return needles.length > 0 && needles.every((w) => haystack.has(w));
}

export function snapshotFromEntry(entry, keyword, today = new Date()) {
  if (typeof entry.trackId !== 'number' || typeof entry.trackName !== 'string') return null;

  const updated = parseDate(entry.currentVersionReleaseDate);
  return {
    trackId: entry.trackId,
    name: entry.trackName,
    seller: entry.sellerName || entry.artistName || 'unknown',
    ratingCount: Number(entry.userRatingCount ?? 0),
    rating: entry.averageUserRating ? Number(entry.averageUserRating) : null,
    price: Number(entry.price ?? 0),
    updated,
    daysSinceUpdate: updated ? daysBetween(updated, today) : null,
    hasKeywordInName: keywordInName(keyword, entry.trackName),
  };
}

/**
 * Piecewise-linear lookup, clamped at both ends.
 *
 * A curve rather than thresholds so one extra competitor never flips a verdict
 * on its own.
 */
export function interpolate(curve, observed) {
  if (!curve?.length) return 0;
  const points = [...curve].sort((a, b) => a[0] - b[0]);
  if (observed <= points[0][0]) return points[0][1];
  if (observed >= points[points.length - 1][0]) return points[points.length - 1][1];

  for (let i = 0; i < points.length - 1; i += 1) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    if (observed >= x0 && observed <= x1) {
      if (x1 === x0) return y0;
      return y0 + ((observed - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return points[points.length - 1][1];
}

function buildAggregates(leaders, allApps, resultCount, seriousThreshold) {
  const ages = leaders.map((a) => a.daysSinceUpdate).filter((d) => d !== null);
  const stars = leaders.map((a) => a.rating).filter((r) => r !== null);

  let keywordShare = 0;
  let repeatShare = 0;
  if (leaders.length) {
    keywordShare = (100 * leaders.filter((a) => a.hasKeywordInName).length) / leaders.length;

    const sellers = new Map();
    for (const app of leaders) sellers.set(app.seller, (sellers.get(app.seller) ?? 0) + 1);
    const repeats = [...sellers.values()].filter((n) => n > 1).reduce((a, b) => a + b, 0);
    repeatShare = (100 * repeats) / leaders.length;
  }

  return {
    result_count: resultCount,
    serious_competitor_count: (allApps.length ? allApps : leaders).filter(
      (a) => a.ratingCount > seriousThreshold,
    ).length,
    median_rating_count: median(leaders.map((a) => a.ratingCount)),
    median_days_since_update: median(ages),
    median_rating: median(stars),
    keyword_in_name_share: keywordShare,
    repeat_publisher_share: repeatShare,
  };
}

function bandFor(score, spec) {
  if (score >= spec.bands.favourable_at) return 'favourable';
  if (score <= spec.bands.hostile_at) return 'hostile';
  return 'neutral';
}

/**
 * Format an observation into its rationale sentence.
 *
 * The templates use Python's format spec (`{observed:,.0f}`), so the two sides
 * share one string rather than maintaining parallel copies of the prose.
 */
function renderRationale(template, observed) {
  if (!template) return '';
  return template.replace(/\{observed(?::([^}]*))?\}/g, (_, spec = '') => {
    const decimals = /\.(\d+)f/.exec(spec)?.[1];
    const digits = decimals === undefined ? 0 : Number(decimals);
    const value = observed.toFixed(digits);
    return spec.includes(',') ? Number(value).toLocaleString('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }) : value;
  });
}

export function analyseKeyword(keyword, { country, resultCount, entries, today = new Date() }) {
  const spec = getMarketSpec();

  const snapshots = entries
    .map((e) => snapshotFromEntry(e, keyword, today))
    .filter((s) => s !== null);
  // The store's own ordering is its relevance ranking; do not re-sort.
  const leaders = snapshots.slice(0, LEADER_SAMPLE);

  const notes = [];
  if (!snapshots.length) {
    notes.push('No apps returned for this term; the signals below are not meaningful.');
  } else if (leaders.length < LEADER_SAMPLE) {
    notes.push(
      `Only ${leaders.length} app(s) available to sample, so the leader signals are noisy.`,
    );
  }
  if (resultCount >= DEFAULT_FETCH_LIMIT) {
    notes.push(
      `The catalogue caps results at ${DEFAULT_FETCH_LIMIT}; the result count is a floor, not a market size.`,
    );
  }

  const aggregates = buildAggregates(
    leaders,
    snapshots,
    resultCount,
    spec.serious_competitor_ratings ?? 1000,
  );

  const signals = snapshots.length
    ? spec.signals.map((signalSpec) => {
        const observed = aggregates[signalSpec.aggregate];
        if (observed === undefined) {
          throw new Error(`market spec references unknown aggregate ${signalSpec.aggregate}`);
        }
        const score = interpolate(signalSpec.curve, observed);
        const band = bandFor(score, spec);
        // Round once and use that value in both the reading and the sentence,
        // so a signal cannot contradict itself on its own line.
        const rounded = Math.round(observed * 100) / 100;
        return {
          code: signalSpec.code,
          label: signalSpec.label,
          observed: rounded,
          unit: signalSpec.unit,
          score: Math.round(score * 10) / 10,
          weight: signalSpec.weight,
          band,
          rationale: renderRationale(signalSpec.rationale?.[band], rounded),
        };
      })
    : [];

  const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);
  const winnability = totalWeight
    ? Math.round((signals.reduce((sum, s) => sum + s.score * s.weight, 0) / totalWeight) * 10) / 10
    : 0;

  const verdict =
    winnability >= spec.verdicts.open_at
      ? 'open'
      : winnability >= spec.verdicts.contested_at
        ? 'contested'
        : 'locked';

  return {
    keyword,
    country: country.toUpperCase(),
    resultCount,
    appsSampled: leaders.length,
    signals,
    topApps: leaders,
    notes,
    winnability,
    verdict,
  };
}

// --- cross-storefront scanning -------------------------------------------

/**
 * Score one keyword across several storefronts.
 *
 * A storefront that fails is recorded and skipped: the sweep runs for a minute
 * against a rate-limited endpoint, and losing thirteen good results to one bad
 * one would be a poor trade.
 */
export async function scanMarkets(
  client,
  keyword,
  countries,
  { limit = DEFAULT_FETCH_LIMIT, today = new Date(), onProgress } = {},
) {
  const results = [];

  for (const [index, raw] of countries.entries()) {
    const country = raw.toLowerCase();
    onProgress?.(country, index + 1, countries.length);

    try {
      const page = await client.search(keyword, { country, limit });
      const report = analyseKeyword(keyword, {
        country,
        resultCount: page.resultCount,
        entries: page.results,
        today,
      });
      results.push({
        country,
        countryName: countryName(country),
        report,
        reduced: Boolean(page.reduced),
        error: null,
      });
    } catch (err) {
      results.push({
        country,
        countryName: countryName(country),
        report: null,
        reduced: false,
        error: err.message,
      });
    }
  }

  const usable = results.filter((r) => r.report);
  const scores = usable.map((r) => r.report.winnability);
  const verdicts = new Set(usable.map((r) => r.report.verdict));

  return {
    keyword,
    results,
    ranked: [...results].sort(
      (a, b) => Number(!a.report) - Number(!b.report) || b.report?.winnability - a.report?.winnability,
    ),
    bestCountry: usable.length
      ? usable.reduce((best, r) => (r.report.winnability > best.report.winnability ? r : best)).country
      : null,
    spread: scores.length > 1 ? Math.round((Math.max(...scores) - Math.min(...scores)) * 10) / 10 : 0,
    // The decision-relevant fact is whether the verdict changes, not the size
    // of the numeric gap: 19 points moving LOCKED to CONTESTED changes what you
    // should do, 30 points inside CONTESTED does not.
    verdictsDiffer: verdicts.size > 1,
    openCountries: results.filter((r) => r.report?.verdict === 'open').map((r) => r.country),
    reducedCountries: results.filter((r) => r.reduced).map((r) => r.country),
    failedCountries: results.filter((r) => !r.report).map((r) => r.country),
  };
}
