/**
 * Suggested per-territory prices — the browser counterpart of
 * `core/services/pricing_calculator`.
 *
 * A read-only sanity check, not a push to any store: this never calls App
 * Store Connect or Play Console. The numbers are a starting point to copy in
 * yourself.
 */

import { countryName } from './market.js';

let SPEC = null;
let CURRENT_PRICES = null;

export function loadPricingSpec(specs) {
  SPEC = specs.pricing ?? specs;
}

/**
 * ISO 3166-1 alpha-3 → the alpha-2 storefront codes this app uses
 * everywhere else. App Store Connect's pricing API identifies a territory
 * by its alpha-3 code (`"USA"`, `"FRA"`); the rest of this codebase — the
 * niche scanner, the pricing tiers, `market_scanner.COUNTRY_NAMES` — has
 * always used alpha-2 (`"us"`, `"fr"`). Scoped to the countries this app
 * already knows about rather than the full ISO list nobody here needs.
 */
const ASC_TERRITORY_TO_COUNTRY = {
  USA: 'us', GBR: 'gb', CAN: 'ca', AUS: 'au', DEU: 'de', FRA: 'fr', ESP: 'es',
  ITA: 'it', NLD: 'nl', SWE: 'se', JPN: 'jp', KOR: 'kr', POL: 'pl', BRA: 'br',
  MEX: 'mx', TUR: 'tr', RUS: 'ru', CHN: 'cn', IND: 'in', IDN: 'id',
};

/**
 * `pulled.current_prices` from `appmates asc pull` — what's actually live
 * right now, shown alongside the suggestion so the two can be compared.
 * Never pushed anywhere; see `core/services/pricing_calculator.py`'s own
 * module docstring for why pricing writes aren't automated at all.
 */
export function setCurrentPrices(prices) {
  CURRENT_PRICES = new Map(
    (prices ?? [])
      .map((p) => [ASC_TERRITORY_TO_COUNTRY[p.territory], p.price])
      .filter(([code]) => code),
  );
}

export function currentPriceFor(countryCode) {
  return CURRENT_PRICES?.get(countryCode.toLowerCase()) ?? null;
}

export function hasCurrentPrices() {
  return Boolean(CURRENT_PRICES?.size);
}

export function getPricingSpec() {
  if (!SPEC) throw new Error('loadPricingSpec() must be called before suggesting prices');
  return SPEC;
}

export function tierFor(country) {
  const code = country.toLowerCase();
  return getPricingSpec().tiers.find((t) => t.countries.includes(code)) ?? null;
}

/**
 * Every storefront the pricing spec has a tier for, deduplicated. The
 * default set to price when the caller does not name specific countries.
 */
export function knownCountries() {
  return [...new Set(getPricingSpec().tiers.flatMap((t) => t.countries))];
}

export function suggestPrices(basePrice, { model = 'ppp_tier', countries } = {}) {
  const spec = getPricingSpec();
  if (!spec.models[model]) {
    throw new Error(`Unknown pricing model "${model}". Choose from: ${Object.keys(spec.models).join(', ')}.`);
  }

  const codes = (countries ?? knownCountries()).map((c) => c.toLowerCase());
  return codes.map((code) => {
    const tier = tierFor(code);
    const multiplier = tier && model === 'ppp_tier' ? tier.multiplier : 1.0;
    return {
      country: code,
      countryName: countryName(code),
      tierId: tier?.id ?? null,
      tierLabel: tier?.label ?? null,
      multiplier,
      suggestedPrice: Math.round(basePrice * multiplier * 100) / 100,
    };
  });
}
