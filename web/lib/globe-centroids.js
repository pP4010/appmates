/**
 * ISO 3166-1 alpha-2 → an approximate country centroid, `[lat, lon]`.
 *
 * The sponsor globe's visitor pins are placed from this table, not from
 * coordinates sent by the server — `community/src/routes/presence.js` only
 * ever ships a country code, and the database behind it stores nothing
 * finer (see `migrations/0014_presence_history.sql`). So a pin is a
 * statement about a country and cannot be anything more precise, no matter
 * what the wire format later grows.
 *
 * A code missing from this table is skipped rather than drawn at [0, 0],
 * which would otherwise drop a phantom pin in the Gulf of Guinea every time
 * somewhere unlisted showed up.
 *
 * Country *names* are deliberately absent: `Intl.DisplayNames` supplies
 * those at render time, localised and for free.
 */
export const CENTROIDS = {
  AD: [42.5, 1.5], AE: [24.0, 54.0], AF: [33.9, 67.7], AL: [41.2, 20.2], AM: [40.1, 45.0],
  AO: [-11.2, 17.9], AR: [-38.4, -63.6], AT: [47.5, 14.6], AU: [-25.3, 133.8], AZ: [40.1, 47.6],
  BA: [43.9, 17.7], BD: [23.7, 90.4], BE: [50.5, 4.5], BF: [12.2, -1.6], BG: [42.7, 25.5],
  BH: [26.1, 50.6], BJ: [9.3, 2.3], BN: [4.5, 114.7], BO: [-16.3, -63.6], BR: [-14.2, -51.9],
  BS: [25.0, -77.4], BW: [-22.3, 24.7], BY: [53.7, 27.9], BZ: [17.2, -88.5],
  CA: [56.1, -106.3], CD: [-4.0, 21.8], CG: [-0.2, 15.8], CH: [46.8, 8.2], CI: [7.5, -5.5],
  CL: [-35.7, -71.5], CM: [7.4, 12.4], CN: [35.9, 104.2], CO: [4.6, -74.3], CR: [9.7, -83.8],
  CU: [21.5, -77.8], CY: [35.1, 33.4], CZ: [49.8, 15.5],
  DE: [51.2, 10.5], DK: [56.3, 9.5], DO: [18.7, -70.2], DZ: [28.0, 1.7],
  EC: [-1.8, -78.2], EE: [58.6, 25.0], EG: [26.8, 30.8], ER: [15.2, 39.8], ES: [40.5, -3.7],
  ET: [9.1, 40.5], FI: [61.9, 25.7], FJ: [-17.7, 178.1], FR: [46.6, 2.2],
  GA: [-0.8, 11.6], GB: [54.0, -2.5], GE: [42.3, 43.4], GH: [7.9, -1.0], GR: [39.1, 21.8],
  GT: [15.8, -90.2], GY: [4.9, -58.9],
  HK: [22.3, 114.2], HN: [15.2, -86.2], HR: [45.1, 15.2], HT: [19.0, -72.3], HU: [47.2, 19.5],
  ID: [-2.5, 118.0], IE: [53.4, -8.2], IL: [31.0, 34.9], IN: [21.0, 78.7], IQ: [33.2, 43.7],
  IR: [32.4, 53.7], IS: [65.0, -18.6], IT: [42.8, 12.6],
  JM: [18.1, -77.3], JO: [30.6, 36.2], JP: [36.2, 138.3],
  KE: [0.0, 37.9], KG: [41.2, 74.8], KH: [12.6, 104.9], KR: [36.5, 127.9], KW: [29.3, 47.6],
  KZ: [48.0, 66.9],
  LA: [19.9, 102.5], LB: [33.9, 35.9], LK: [7.9, 80.8], LT: [55.2, 23.9], LU: [49.8, 6.1],
  LV: [56.9, 24.6], LY: [26.3, 17.2],
  MA: [31.8, -7.1], MD: [47.4, 28.4], ME: [42.7, 19.4], MG: [-18.8, 46.9], MK: [41.6, 21.7],
  ML: [17.6, -4.0], MM: [21.9, 95.96], MN: [46.9, 103.8], MO: [22.2, 113.5], MT: [35.9, 14.4],
  MU: [-20.3, 57.6], MV: [3.2, 73.2], MW: [-13.3, 34.3], MX: [23.6, -102.6], MY: [4.2, 101.98],
  MZ: [-18.7, 35.5],
  NA: [-22.96, 18.5], NG: [9.1, 8.7], NI: [12.9, -85.2], NL: [52.1, 5.3], NO: [60.5, 8.5],
  NP: [28.4, 84.1], NZ: [-40.9, 174.9],
  OM: [21.5, 55.9],
  PA: [8.5, -80.8], PE: [-9.2, -75.0], PH: [12.9, 121.8], PK: [30.4, 69.3], PL: [51.9, 19.1],
  PR: [18.2, -66.6], PS: [31.95, 35.2], PT: [39.4, -8.2], PY: [-23.4, -58.4],
  QA: [25.4, 51.2],
  RO: [45.9, 25.0], RS: [44.0, 21.0], RU: [61.5, 90.0], RW: [-1.9, 29.9],
  SA: [23.9, 45.1], SD: [12.9, 30.2], SE: [60.1, 18.6], SG: [1.35, 103.8], SI: [46.2, 15.0],
  SK: [48.7, 19.7], SN: [14.5, -14.5], SV: [13.8, -88.9], SY: [34.8, 39.0],
  TH: [15.9, 101.0], TJ: [38.9, 71.3], TN: [33.9, 9.5], TR: [39.0, 35.2], TT: [10.7, -61.2],
  TW: [23.7, 121.0], TZ: [-6.4, 34.9],
  UA: [48.4, 31.2], UG: [1.4, 32.3], US: [39.8, -98.6], UY: [-32.5, -55.8], UZ: [41.4, 64.6],
  VE: [6.4, -66.6], VN: [14.06, 108.3],
  YE: [15.6, 48.5],
  ZA: [-30.6, 22.9], ZM: [-13.1, 27.8], ZW: [-19.0, 29.2],
};

/** The flag emoji for an ISO2 code, built from the regional-indicator block
 * — no image, no font file, no lookup table. Empty string for anything that
 * isn't two ASCII letters, so a caller can `||` it away. */
export function flagFor(code) {
  if (!/^[A-Za-z]{2}$/.test(code || '')) return '';
  return String.fromCodePoint(...[...code.toUpperCase()].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

/** `Intl.DisplayNames` in a try/catch that survives an engine without it —
 * without the guard a single throw takes down the whole feed render, and a
 * bare country code is a perfectly readable fallback. */
const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return null;
  }
})();

export function countryName(code) {
  if (!code) return 'somewhere';
  try {
    return regionNames?.of(code) || code;
  } catch {
    return code;
  }
}

/** Sentence form, for "someone in ___ is reading ___" — a handful of
 * country names only read correctly with an article in front. */
const TAKES_THE = new Set(['US', 'GB', 'NL', 'PH', 'AE', 'DO', 'CZ', 'CD']);

export function countryInSentence(code) {
  if (!code) return 'somewhere';
  const name = countryName(code);
  return TAKES_THE.has(code.toUpperCase()) ? `the ${name}` : name;
}
