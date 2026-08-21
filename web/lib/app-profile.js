/**
 * Listing health — the browser counterpart of `core/services/app_profile`.
 *
 * Three limits bound what can be known about a published listing, and each is
 * surfaced rather than worked around:
 *
 * Screenshot URLs serve a downscaled image that preserves the aspect ratio but
 * not the resolution, so device family is inferred and pixel size is never
 * claimed. The catalogue exposes iPhone screenshots for roughly half of apps,
 * so an empty set means it withheld them. Subtitles and the keyword field are
 * not public at all.
 *
 * A check that cannot be answered is marked unanswerable rather than failed,
 * and excluded from the score. An app whose screenshots the catalogue happened
 * to withhold must not rank below one whose it happened to return.
 */

const SIZE_RE = /\/(\d+)x(\d+)[a-z]*\.(?:png|jpg|jpeg)$/i;

let SPEC = null;

export function loadAppHealthSpec(specs) {
  SPEC = specs.app_health ?? specs;
}

export function getAppHealthSpec() {
  if (!SPEC) throw new Error('loadAppHealthSpec() must be called before checking');
  return SPEC;
}

function parseDate(value) {
  if (typeof value !== 'string' || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isoDate(date) {
  return date ? date.toISOString().slice(0, 10) : null;
}

/** Long side over short side of the served image. */
export function screenshotRatio(url) {
  const match = SIZE_RE.exec(url);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return null;
  return Math.max(width, height) / Math.min(width, height);
}

/** Guess the device family a set of screenshots targets, from their ratio. */
export function inferDevice(urls, spec = getAppHealthSpec()) {
  const ratios = urls.map(screenshotRatio).filter((r) => r !== null);
  if (!ratios.length) return null;
  const observed = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const match = spec.device_ratios.find(
    (d) => Math.abs(observed - d.ratio) <= spec.thresholds.ratio_tolerance,
  );
  return match?.name ?? null;
}

export function profileFromEntry(entry, spec = getAppHealthSpec()) {
  const iphone = (entry.screenshotUrls ?? []).filter((u) => typeof u === 'string');
  const ipad = (entry.ipadScreenshotUrls ?? []).filter((u) => typeof u === 'string');

  const devices = (entry.supportedDevices ?? []).filter((d) => typeof d === 'string');
  const supportsIphone =
    devices.some((d) => d.includes('iPhone') || d.includes('iPod')) || devices.length === 0;
  const supportsIpad = devices.some((d) => d.includes('iPad'));

  const released = parseDate(entry.releaseDate);
  const updated = parseDate(entry.currentVersionReleaseDate);
  const fileSizeBytes = Number(entry.fileSizeBytes ?? 0);

  return {
    trackId: entry.trackId,
    bundleId: entry.bundleId ?? null,
    name: entry.trackName ?? '',
    seller: entry.sellerName || entry.artistName || 'unknown',
    storeUrl: entry.trackViewUrl ?? null,
    artwork: entry.artworkUrl512 ?? entry.artworkUrl100 ?? null,
    version: entry.version ?? null,
    releaseNotes: entry.releaseNotes ?? null,
    description: entry.description ?? '',
    released,
    updated,
    releasedOn: isoDate(released),
    updatedOn: isoDate(updated),
    rating: entry.averageUserRating ? Number(entry.averageUserRating) : null,
    ratingCount: Number(entry.userRatingCount ?? 0),
    price: Number(entry.price ?? 0),
    formattedPrice: entry.formattedPrice ?? null,
    genres: (entry.genres ?? []).filter((g) => typeof g === 'string'),
    primaryGenre: entry.primaryGenreName ?? null,
    contentRating: entry.contentAdvisoryRating ?? null,
    minimumOs: entry.minimumOsVersion ?? null,
    fileSizeBytes,
    sizeMb: Math.round((fileSizeBytes / 1_048_576) * 10) / 10,
    isFree: Number(entry.price ?? 0) === 0,
    locales: (entry.languageCodesISO2A ?? []).filter((c) => typeof c === 'string'),
    iphoneScreenshots: iphone,
    ipadScreenshots: ipad,
    screenshotsExposed: iphone.length > 0 || ipad.length > 0,
    supportsIphone,
    supportsIpad,
    inferredDevice: inferDevice(iphone.length ? iphone : ipad, spec),
  };
}

function daysBetween(from, to) {
  return Math.floor((to - from) / 86_400_000);
}

/** Run the readiness checks over a profile. */
export function checkAppHealth(profile, { today = new Date() } = {}) {
  const spec = getAppHealthSpec();
  const limits = spec.thresholds;
  const checks = [];

  const add = (code, label, passed, detail, { fixHint = null, checkable = true } = {}) =>
    checks.push({
      code,
      label,
      passed,
      detail,
      severity: spec.findings?.[code] ?? 'warning',
      fixHint,
      checkable,
    });

  // --- name ---------------------------------------------------------------
  const length = profile.name.length;
  add(
    'APP_TITLE_TOO_LONG',
    'App name within 30 characters',
    length <= limits.title_max,
    `${length} of ${limits.title_max} characters used.`,
    { fixHint: length > limits.title_max ? `Trim ${length - limits.title_max} character(s).` : null },
  );

  // --- description --------------------------------------------------------
  add(
    'APP_NO_DESCRIPTION',
    'Description present',
    Boolean(profile.description.trim()),
    profile.description
      ? `${profile.description.length} characters.`
      : 'The catalogue returned no description.',
  );

  // --- screenshots --------------------------------------------------------
  if (!profile.screenshotsExposed) {
    add(
      'APP_SCREENSHOTS_NOT_EXPOSED',
      'Screenshots',
      false,
      'The catalogue did not return screenshot URLs for this app, so they cannot be ' +
        'checked here. This happens for roughly half of apps and says nothing about ' +
        'whether yours are correct.',
      { fixHint: 'Check them directly with `appmates validate-screenshots`.', checkable: false },
    );
  } else {
    const count = profile.iphoneScreenshots.length;
    // An app that supports iPhone but exposed no iPhone screenshots has almost
    // certainly shipped them and the API withheld them, which is not a defect.
    const iphoneAnswerable = count > 0 || !profile.supportsIphone;

    add(
      'APP_TOO_FEW_SCREENSHOTS',
      'At least three iPhone screenshots',
      count >= limits.min_screenshots || !profile.supportsIphone,
      count
        ? `${count} exposed.`
        : 'The catalogue returned iPad screenshots but not iPhone ones, which it does ' +
          'for about half of apps. Nothing can be concluded from that.',
      {
        fixHint:
          iphoneAnswerable && count < limits.min_screenshots
            ? 'Three is the practical floor for a listing that reads as finished.'
            : null,
        checkable: iphoneAnswerable,
      },
    );
    add(
      'APP_UNUSED_SCREENSHOT_SLOTS',
      'Using the available screenshot slots',
      count >= limits.max_screenshots,
      count ? `${count} of ${limits.max_screenshots} slots used.` : 'Not visible.',
      {
        fixHint:
          iphoneAnswerable && count < limits.max_screenshots
            ? `${limits.max_screenshots - count} slot(s) left unused.`
            : null,
        checkable: iphoneAnswerable,
      },
    );
    add(
      'APP_SCREENSHOT_RATIO_UNKNOWN',
      'Screenshot aspect ratio recognised',
      profile.inferredDevice !== null,
      profile.inferredDevice
        ? `Matches ${profile.inferredDevice}.`
        : 'The aspect ratio matches no current device family.',
      {
        fixHint:
          'Only the ratio is visible here — the catalogue serves a downscaled image, ' +
          'so the uploaded resolution cannot be checked.',
      },
    );
    add(
      'APP_NO_IPAD_SCREENSHOTS',
      'iPad screenshots present',
      profile.ipadScreenshots.length > 0 || !profile.supportsIpad,
      profile.ipadScreenshots.length
        ? `${profile.ipadScreenshots.length} exposed.`
        : profile.supportsIpad
          ? 'Not exposed.'
          : 'The app does not run on iPad.',
      {
        fixHint:
          profile.supportsIpad && !profile.ipadScreenshots.length
            ? 'Apple requires them for any app that runs on iPad.'
            : null,
        checkable: profile.ipadScreenshots.length > 0 || !profile.supportsIpad,
      },
    );
  }

  // --- freshness ----------------------------------------------------------
  const days = profile.updated ? daysBetween(profile.updated, today) : null;
  if (days === null) {
    add('APP_STALE', 'Recently updated', false, 'No update date in the catalogue.', {
      checkable: false,
    });
  } else {
    add(
      days >= limits.stale_days_error ? 'APP_VERY_STALE' : 'APP_STALE',
      'Recently updated',
      days < limits.stale_days_warning,
      `Last shipped ${days} days ago.`,
      {
        fixHint:
          days >= limits.stale_days_warning
            ? 'Reviewers and users both read a stale date as an abandoned app.'
            : null,
      },
    );
  }

  const notes = (profile.releaseNotes ?? '').trim();
  add(
    'APP_NO_RELEASE_NOTES',
    'Release notes written',
    notes.length >= limits.release_notes_min_length,
    profile.releaseNotes ? `${profile.releaseNotes.length} characters.` : 'None returned.',
    {
      fixHint: profile.releaseNotes
        ? null
        : "'Bug fixes and improvements' is a wasted slot on the product page.",
    },
  );

  // --- reach --------------------------------------------------------------
  // `languageCodesISO2A` is the least reliable field the catalogue serves: apps
  // confirmed to have several App Store Connect localizations have been observed
  // reporting only English here, in every storefront and both catalogue
  // endpoints. A low count only ever indicates the field under-reporting, not a
  // real single-language listing, so it is treated as unanswerable rather than
  // scored — the same asymmetry as screenshots above. A count over the
  // threshold is still trustworthy: the catalogue has no reason to fabricate
  // extra languages.
  const fewLocales = profile.locales.length <= limits.few_locales;
  add(
    'APP_FEW_LOCALES',
    'Localised beyond one language',
    !fewLocales,
    fewLocales
      ? `The catalogue reports only ${profile.locales.length} language(s)` +
        (profile.locales.length ? `: ${profile.locales.join(', ')}` : '') +
        ', but this field is known to under-report real localizations, so it cannot be trusted here.'
      : `${profile.locales.length} language(s): ${profile.locales.slice(0, 8).join(', ')}`,
    {
      fixHint: fewLocales
        ? 'Check your actual localizations in App Store Connect, or view the listing on ' +
          'another storefront directly (e.g. apps.apple.com/fr/app/id...) — see the Markets tool.'
        : null,
      checkable: !fewLocales,
    },
  );

  add(
    'APP_OVER_CELLULAR_LIMIT',
    'Downloadable over cellular',
    profile.fileSizeBytes > 0 && profile.fileSizeBytes <= limits.cellular_download_bytes,
    // toFixed(1), not the bare number: Python rounds to one decimal and prints
    // "50.0 MB" where JavaScript would drop the trailing zero and print "50 MB".
    profile.fileSizeBytes ? `${profile.sizeMb.toFixed(1)} MB.` : 'No size reported.',
    {
      fixHint:
        profile.fileSizeBytes > limits.cellular_download_bytes
          ? `Over ${Math.floor(limits.cellular_download_bytes / 1_048_576)} MB needs Wi-Fi ` +
            'unless the user has opted in — friction at the moment they decided to install.'
          : null,
      checkable: profile.fileSizeBytes > 0,
    },
  );

  add(
    'APP_LOW_RATINGS',
    'Enough ratings to look established',
    profile.ratingCount >= limits.low_rating_count,
    `${profile.ratingCount.toLocaleString('en-US')} rating(s)` +
      (profile.rating ? ` at ${profile.rating.toFixed(1)}★.` : '.'),
    {
      fixHint:
        profile.ratingCount < limits.low_rating_count
          ? 'Below a hundred ratings, the listing reads as unproven.'
          : null,
    },
  );

  const answerable = checks.filter((c) => c.checkable);
  const passed = answerable.filter((c) => c.passed);
  const findings = answerable
    .filter((c) => !c.passed)
    .map((c) => ({
      code: c.code,
      severity: c.severity,
      message: `${c.label}: ${c.detail}`,
      store: 'apple',
      fixHint: c.fixHint,
      metadata: {},
    }));

  const order = { error: 0, warning: 1, info: 2 };

  return {
    profile,
    checks,
    findings,
    // Unanswerable checks are excluded rather than counted either way.
    score: answerable.length ? Math.round((1000 * passed.length) / answerable.length) / 10 : 0,
    passedCount: passed.length,
    checkedCount: answerable.length,
    unknownCount: checks.length - answerable.length,
    status: findings.some((f) => f.severity === 'error')
      ? 'fail'
      : findings.some((f) => f.severity === 'warning')
        ? 'warn'
        : 'pass',
    failing: answerable
      .filter((c) => !c.passed)
      .sort((a, b) => order[a.severity] - order[b.severity]),
  };
}
