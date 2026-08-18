/**
 * Listing text limits — the browser counterpart of
 * `core/services/metadata_validator`.
 *
 * Text overruns are the second most common cause of a blocked submission after
 * malformed screenshots, and the limits differ per store: the same listing can
 * pass Apple and fail Play.
 */

let LIMITS = {};

export function loadListingLimits(specs) {
  LIMITS = specs.listing_limits ?? specs;
}

export function getLimits(store) {
  return LIMITS[store] ?? {};
}

export function listStores() {
  return Object.keys(LIMITS);
}

/**
 * Fields close to their ceiling, flagged before they break.
 *
 * Translations run longer than English — commonly 15-30% for German and French
 * — so a title at 29 of 30 characters is a localisation problem waiting to
 * happen, not a success.
 */
const NEAR_LIMIT_RATIO = 0.9;

function finding(code, severity, message, { store = null, fixHint = null, field = null } = {}) {
  return { code, severity, message, store, fixHint, metadata: field ? { field } : {} };
}

export function validateListing(values, { stores = listStores() } = {}) {
  const findings = [];
  const fields = [];

  for (const store of stores) {
    const limits = getLimits(store);
    const prefix = store.toUpperCase();

    for (const [key, limit] of Object.entries(limits)) {
      const value = values[key] ?? '';
      const length = [...value].length; // count code points, not UTF-16 units
      const over = length - limit.max_length;

      if (!value && limit.required) {
        findings.push(
          finding(`${prefix}_MISSING_FIELD`, 'error', `${limit.name} is required.`, {
            store,
            fixHint: `Add a ${limit.name.toLowerCase()}.`,
            field: key,
          }),
        );
        continue;
      }
      if (!value) continue;

      if (over > 0) {
        findings.push(
          finding(
            `${prefix}_FIELD_TOO_LONG`,
            'error',
            `${limit.name} is ${length} characters, ${over} over the ${limit.max_length} limit.`,
            { store, fixHint: `Remove ${over} character(s).`, field: key },
          ),
        );
      } else if (length >= limit.max_length * NEAR_LIMIT_RATIO) {
        findings.push(
          finding(
            `${prefix}_FIELD_NEAR_LIMIT`,
            'warning',
            `${limit.name} uses ${length} of ${limit.max_length} characters.`,
            {
              store,
              fixHint:
                'Translations usually run longer than English; leave room before localising.',
              field: key,
            },
          ),
        );
      }
    }
  }

  // One row per field per store, for the meter display.
  for (const store of stores) {
    for (const [key, limit] of Object.entries(getLimits(store))) {
      const value = values[key] ?? '';
      fields.push({
        store,
        key,
        name: limit.name,
        required: Boolean(limit.required),
        length: [...value].length,
        maxLength: limit.max_length,
        value,
      });
    }
  }

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;

  return {
    stores,
    fields,
    findings,
    errorCount: errors,
    warningCount: warnings,
    status: errors ? 'fail' : warnings ? 'warn' : 'pass',
  };
}

/**
 * The same check as `validateListing`, run over every locale in one listing.
 *
 * Mirrors `MetadataValidator.validate_listing`/`LocaleReport` on the Python
 * side, which has always taken a whole `AppListing` — the six-input web form
 * only ever checked one locale at a time. `entries` is `[{locale, title,
 * subtitle, ...}]`, the same shape the CLI's `validate-metadata` reads from a
 * listing file, so a document written for one works unchanged for the other.
 */
export function validateLocales(entries, { stores = listStores() } = {}) {
  const locales = entries.map((entry) => {
    const { locale = 'en-US', ...values } = entry;
    const report = validateListing(values, { stores });
    return { locale, ...report };
  });

  const allFindings = locales.flatMap((l) => l.findings);
  const errorCount = allFindings.filter((f) => f.severity === 'error').length;
  const warningCount = allFindings.filter((f) => f.severity === 'warning').length;

  return {
    stores,
    locales,
    allFindings,
    errorCount,
    warningCount,
    status: errorCount ? 'fail' : warningCount ? 'warn' : 'pass',
  };
}
