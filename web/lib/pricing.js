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

export function loadPricingSpec(specs) {
  SPEC = specs.pricing ?? specs;
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
