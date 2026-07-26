/**
 * Rule engine — the browser counterpart of `core/services/image_validator.ScreenshotValidator`.
 *
 * The numbers all come from `specs.json`, generated from the same YAML the CLI
 * reads, so a store rule change is a one-line YAML edit on both sides. Only the
 * rule *logic* is expressed twice, and `test/conformance.test.js` asserts the two
 * implementations agree finding-for-finding on a corpus generated from Python.
 *
 * Finding codes are identical to the CLI's on purpose: they are the product's
 * public contract.
 */

import { aspectRatio } from './image-facts.js';

export const Severity = { ERROR: 'error', WARNING: 'warning', INFO: 'info' };
export const Status = { PASS: 'pass', WARN: 'warn', FAIL: 'fail' };

/** Pillow modes considered RGB-compatible, matching `_RGB_MODES`. */
const RGB_MODES = new Set(['RGB', 'RGBA', 'L', 'LA', 'P', 'PA', '1']);

let SPECS = null;

/** Inject the generated catalogue. Call once at startup. */
export function loadSpecs(specs) {
  SPECS = specs.stores ?? specs;
}

export function getSpec(store) {
  if (!SPECS) throw new Error('loadSpecs() must be called before validating');
  return SPECS[store];
}

export function listStores() {
  return Object.keys(SPECS ?? {});
}

function finding(code, severity, message, { store = null, fixHint = null, fixable = false } = {}) {
  return { code, severity, message, store, fixHint, fixable };
}

function portrait(size) {
  return [Math.min(size.width, size.height), Math.max(size.width, size.height)];
}

function sizeMatches(size, width, height) {
  const [pw, ph] = portrait(size);
  return pw === Math.min(width, height) && ph === Math.max(width, height);
}

function sizeLabel(size) {
  return `${size.device_class} (${size.width}x${size.height})`;
}

/** Exact match in either orientation, preferring current sizes over legacy ones. */
function findExact(spec, width, height) {
  const matches = spec.sizes.filter((s) => sizeMatches(s, width, height));
  if (matches.length === 0) return null;
  const current = matches.find((s) => s.status !== 'legacy' && s.status !== 'deprecated');
  return current ?? matches[0];
}

/** Closest non-legacy size, used to suggest what the author probably meant. */
function findNearest(spec, width, height) {
  const candidates = spec.sizes.filter(
    (s) => s.status === 'required' || s.status === 'accepted',
  );
  if (candidates.length === 0) return null;
  const pw = Math.min(width, height);
  const ph = Math.max(width, height);
  return candidates.reduce((best, s) => {
    const [sw, sh] = portrait(s);
    const distance = Math.abs(sw - pw) + Math.abs(sh - ph);
    const [bw, bh] = portrait(best);
    const bestDistance = Math.abs(bw - pw) + Math.abs(bh - ph);
    return distance < bestDistance ? s : best;
  });
}

function getSizeById(spec, id) {
  return spec.sizes.find((s) => s.id === id) ?? null;
}

// --- per-file rules ------------------------------------------------------

function checkFormat(facts, spec, store) {
  const prefix = store.toUpperCase();
  const rules = spec.rules;
  const out = [];

  const fmt = (facts.imageFormat ?? '').toUpperCase();
  const allowed = rules.formats.map((f) => f.toUpperCase());
  if (fmt && !allowed.includes(fmt)) {
    out.push(
      finding(
        `${prefix}_FORMAT`,
        Severity.ERROR,
        `Format ${fmt} is not accepted (allowed: ${rules.formats.join(', ')}).`,
        { store, fixHint: 'Re-export as PNG or JPEG.', fixable: true },
      ),
    );
  }

  if (facts.hasAlpha && !rules.allow_alpha) {
    out.push(
      finding(
        `${prefix}_ALPHA_CHANNEL`,
        Severity.ERROR,
        `Image has an alpha channel (mode ${facts.mode}). Transparency is not allowed.`,
        { store, fixHint: 'Flatten onto an opaque background.', fixable: true },
      ),
    );
  }

  if (rules.required_color_spaces?.length && !RGB_MODES.has(facts.mode)) {
    out.push(
      finding(
        `${prefix}_COLOR_SPACE`,
        Severity.ERROR,
        `Colour mode ${facts.mode} is not RGB-compatible.`,
        { store, fixHint: 'Convert to sRGB.', fixable: true },
      ),
    );
  }
  return out;
}

/** Apple publishes an exact size table and applies zero tolerance. */
function checkAppleSize(facts, spec) {
  const out = [];
  const hit = findExact(spec, facts.width, facts.height);

  if (hit === null) {
    const nearest = findNearest(spec, facts.width, facts.height);
    out.push(
      finding(
        'APPLE_SIZE_UNKNOWN',
        Severity.ERROR,
        `${facts.width}x${facts.height} matches no accepted App Store size.`,
        {
          store: 'apple',
          fixHint: nearest
            ? `Closest accepted size is ${sizeLabel(nearest)}.`
            : 'See the specs table.',
          fixable: true,
        },
      ),
    );
    return { matched: null, findings: out };
  }

  if (hit.status === 'deprecated') {
    out.push(
      finding(
        'APPLE_SIZE_DEPRECATED',
        Severity.ERROR,
        `${sizeLabel(hit)} is no longer accepted by App Store Connect.`,
        { store: 'apple', fixHint: 'Re-export at a current size.', fixable: true },
      ),
    );
  } else if (hit.status === 'legacy') {
    // Prefer the documented successor over a raw pixel-distance guess: 1242x2688
    // is conceptually a 6.5" screenshot even though 6.3" is numerically closer.
    const successor =
      (hit.supersedes ? getSizeById(spec, hit.supersedes) : null) ??
      findNearest(spec, facts.width, facts.height);
    out.push(
      finding(
        'APPLE_LEGACY_SIZE',
        Severity.WARNING,
        `${facts.width}x${facts.height} is a legacy size, absent from Apple's current specification table.`,
        {
          store: 'apple',
          fixHint: successor ? `Current equivalent is ${sizeLabel(successor)}.` : null,
          fixable: true,
        },
      ),
    );
  }
  return { matched: hit, findings: out };
}

/** Play publishes constraints rather than a size table. */
function checkGoogleSize(facts, spec) {
  const rules = spec.rules;
  const out = [];
  const short = Math.min(facts.width, facts.height);
  const long = Math.max(facts.width, facts.height);

  if (rules.min_side != null && short < rules.min_side) {
    out.push(
      finding(
        'PLAY_SIDE_TOO_SMALL',
        Severity.ERROR,
        `Shortest side ${short}px is below the ${rules.min_side}px minimum.`,
        { store: 'google', fixHint: 'Re-export at 1080x1920 or larger.', fixable: true },
      ),
    );
  }

  if (rules.max_side != null && long > rules.max_side) {
    out.push(
      finding(
        'PLAY_SIDE_TOO_LARGE',
        Severity.ERROR,
        `Longest side ${long}px exceeds the ${rules.max_side}px maximum.`,
        { store: 'google', fixHint: 'Downscale the screenshot.', fixable: true },
      ),
    );
  }

  // The rule that quietly rejects tall modern phone screenshots.
  if (rules.max_side_ratio != null && short && long > short * rules.max_side_ratio) {
    out.push(
      finding(
        'PLAY_MAX_TWICE_MIN',
        Severity.ERROR,
        `Longest side (${long}px) is more than ${rules.max_side_ratio}x the shortest (${short}px). Play rejects this even at a valid resolution.`,
        {
          store: 'google',
          fixHint: `Crop or letterbox to at most ${short}x${Math.trunc(short * rules.max_side_ratio)}.`,
          fixable: true,
        },
      ),
    );
  }

  if (rules.preferred_aspect_ratio != null) {
    const delta = Math.abs(aspectRatio(facts) - rules.preferred_aspect_ratio);
    if (delta > rules.aspect_ratio_tolerance) {
      out.push(
        finding(
          'PLAY_ASPECT_RATIO',
          Severity.WARNING,
          `Aspect ratio ${aspectRatio(facts)}:1 differs from the documented 16:9 / 9:16.`,
          {
            store: 'google',
            fixHint: 'Play tolerates this in practice, but 1080x1920 is safest.',
            fixable: true,
          },
        ),
      );
    }
  }

  const recW = rules.recommended_min_width;
  const recH = rules.recommended_min_height;
  if (recW && recH && (short < recW || long < recH)) {
    out.push(
      finding(
        'PLAY_BELOW_RECOMMENDED',
        Severity.WARNING,
        `${facts.width}x${facts.height} is below the ${recW}x${recH} recommended minimum for promotional eligibility.`,
        { store: 'google', fixHint: `Export at ${recW}x${recH} or larger.` },
      ),
    );
  }
  return out;
}

function checkGoogleWeight(facts, spec) {
  const limit = spec.rules.max_bytes;
  if (limit != null && facts.sizeBytes > limit) {
    return [
      finding(
        'PLAY_FILE_TOO_LARGE',
        Severity.ERROR,
        `File is ${(facts.sizeBytes / 1048576).toFixed(1)} MB, over the ${Math.round(limit / 1048576)} MB limit.`,
        { store: 'google', fixHint: 'Re-encode as JPEG or compress the PNG.', fixable: true },
      ),
    ];
  }
  return [];
}

export function statusOf(findings) {
  if (findings.some((f) => f.severity === Severity.ERROR)) return Status.FAIL;
  if (findings.some((f) => f.severity === Severity.WARNING)) return Status.WARN;
  return Status.PASS;
}

/**
 * Validate one image's facts against the given stores.
 *
 * @param {object} facts   from `readFacts`
 * @param {string[]} stores
 */
export function validateFacts(facts, stores = ['apple']) {
  const findings = [];
  let matched = null;

  for (const store of stores) {
    const spec = getSpec(store);
    findings.push(...checkFormat(facts, spec, store));
    if (store === 'apple') {
      const result = checkAppleSize(facts, spec);
      matched = matched ?? result.matched;
      findings.push(...result.findings);
    } else {
      findings.push(...checkGoogleSize(facts, spec));
      findings.push(...checkGoogleWeight(facts, spec));
    }
  }

  return {
    facts,
    findings,
    matchedSpecId: matched?.id ?? null,
    deviceClass: matched?.device_class ?? null,
    status: statusOf(findings),
  };
}

// --- set-level rules -----------------------------------------------------

/**
 * Rules about the collection rather than any single file.
 *
 * A directory of individually valid screenshots is still rejected for having
 * eleven of them, or for mixing two device classes across one locale.
 */
export function validateSet(assets, stores = ['apple']) {
  const findings = [];
  const count = assets.length;

  if (count === 0) {
    findings.push(
      finding('SET_EMPTY', Severity.ERROR, 'No PNG or JPEG screenshots found.'),
    );
    return findings;
  }

  for (const store of stores) {
    const rules = getSpec(store).rules;
    const prefix = store.toUpperCase();

    if (rules.min_count != null && count < rules.min_count) {
      findings.push(
        finding(
          `${prefix}_TOO_FEW`,
          Severity.ERROR,
          `${count} screenshot(s) found; at least ${rules.min_count} required.`,
          { store },
        ),
      );
    }
    if (rules.max_count != null && count > rules.max_count) {
      findings.push(
        finding(
          `${prefix}_TOO_MANY`,
          Severity.ERROR,
          `${count} screenshots found; at most ${rules.max_count} allowed.`,
          { store, fixHint: `Remove ${count - rules.max_count} file(s).` },
        ),
      );
    }
  }

  if (stores.includes('apple')) {
    const rules = getSpec('apple').rules;
    const byClass = new Map();
    for (const asset of assets) {
      if (asset.deviceClass) {
        byClass.set(asset.deviceClass, (byClass.get(asset.deviceClass) ?? 0) + 1);
      }
    }
    for (const [deviceClass, n] of [...byClass].sort()) {
      if (rules.max_count_per_class != null && n > rules.max_count_per_class) {
        findings.push(
          finding(
            'APPLE_TOO_MANY_PER_CLASS',
            Severity.ERROR,
            `${n} screenshots for ${deviceClass}; App Store Connect accepts at most ${rules.max_count_per_class} per display size.`,
            { store: 'apple', fixHint: `Remove ${n - rules.max_count_per_class} file(s) for this size.` },
          ),
        );
      }
    }
  }

  const sizes = new Map();
  for (const asset of assets) {
    if (!asset.facts) continue;
    const key = `${asset.facts.width}x${asset.facts.height}`;
    sizes.set(key, (sizes.get(key) ?? 0) + 1);
  }
  if (sizes.size > 1) {
    const listed = [...sizes]
      .sort((a, b) => b[1] - a[1])
      .map(([key, n]) => `${key} (${n})`)
      .join(', ');
    findings.push(
      finding(
        'SET_MIXED_SIZES',
        Severity.WARNING,
        `Directory mixes ${sizes.size} different sizes: ${listed}.`,
        { fixHint: 'Keep one display size per directory, one directory per locale.' },
      ),
    );
  }
  return findings;
}

/**
 * Guess which store a set of screenshots targets.
 *
 * App Store and Play screenshots are different assets — every current Apple
 * iPhone size violates Play's long-side rule — so checking one batch against
 * both always produces noise. Pick whichever store the files actually fit.
 */
export function detectTargetStore(factsList) {
  if (factsList.length === 0) return 'apple';
  const score = (store) =>
    factsList.reduce(
      (total, facts) =>
        total + validateFacts(facts, [store]).findings.filter((f) => f.severity === Severity.ERROR).length,
      0,
    );
  return score('apple') <= score('google') ? 'apple' : 'google';
}
