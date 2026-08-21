/**
 * The land mask behind the sponsor page's visitor globe — coarse coastline
 * polygons, sampled once into a fixed cloud of unit vectors that
 * `lib/globe.js` only has to rotate and project per frame.
 *
 * Polygons rather than the bounding boxes this used to use: a box has
 * corners, and at ~2px per dot a corner is exactly what makes a rotating
 * sphere read as a grid instead of as Earth. These outlines are still
 * nowhere near survey-grade — they are a dozen hand-placed rings, chosen so
 * the silhouette is recognisable at 380px while rotating, and no more.
 */

const DEG2RAD = Math.PI / 180;

/**
 * Coastlines as `[lat, lon]` rings.
 *
 * Every ring must stay inside one continuous longitude range. The
 * point-in-polygon test below casts its ray along a line of latitude, so a
 * ring that straddles the antimeridian wraps around and paints a stripe
 * across the whole globe — which is why Asia stops dead at lon 180 and
 * loses the tip of Chukotka rather than reaching over into -170.
 */
const LAND = [
  // North America, Alaska included, closing back around the Aleutian side
  [[71, -156], [70, -141], [69, -127], [68, -105], [73, -95], [70, -85], [63, -78], [60, -65],
   [52, -56], [47, -53], [45, -61], [41, -70], [36, -76], [30, -81], [25, -80], [29, -89],
   [26, -97], [22, -98], [18, -95], [20, -105], [23, -110], [32, -117], [40, -124], [48, -125],
   [55, -133], [59, -140], [60, -148], [58, -153], [55, -162], [60, -166], [65, -164], [68, -166]],
  // Greenland
  [[83, -33], [81, -17], [76, -19], [70, -22], [64, -40], [60, -44], [67, -53], [73, -56],
   [78, -73], [82, -60]],
  // Central America, down to the isthmus
  [[18, -95], [16, -88], [13, -83], [9, -79], [7, -77], [9, -84], [14, -92], [16, -95]],
  // South America
  [[12, -72], [11, -64], [8, -60], [5, -52], [0, -50], [-5, -36], [-9, -35], [-13, -38],
   [-18, -39], [-23, -41], [-27, -48], [-33, -53], [-38, -57], [-42, -63], [-47, -66],
   [-52, -68], [-55, -67], [-53, -73], [-45, -74], [-38, -73], [-30, -71], [-23, -70],
   [-18, -70], [-12, -77], [-5, -81], [0, -80], [6, -77], [9, -76]],
  // Europe, Scandinavia round to Iberia
  [[71, 26], [68, 40], [62, 33], [57, 22], [54, 20], [50, 30], [46, 32], [41, 28], [36, 23],
   [38, 15], [41, 9], [44, 10], [45, 13], [42, 18], [44, 12], [43, 4], [40, 0], [36, -5],
   [39, -9], [43, -9], [44, -1], [48, -5], [51, 2], [54, 8], [57, 8], [58, 11], [59, 5],
   [63, 7], [67, 13], [70, 20]],
  // Great Britain
  [[59, -3], [58, -2], [55, -1], [53, 0], [51, 1], [50, -4], [52, -5], [54, -3], [55, -5],
   [57, -6], [58, -5]],
  // Ireland
  [[55, -7], [54, -6], [52, -6], [51, -9], [53, -10], [55, -8]],
  // Africa
  [[37, 10], [33, 11], [31, 20], [32, 25], [31, 32], [27, 34], [22, 37], [15, 40], [11, 43],
   [12, 51], [8, 48], [2, 42], [-4, 40], [-11, 40], [-16, 40], [-20, 35], [-25, 33], [-29, 32],
   [-34, 26], [-34, 20], [-31, 18], [-26, 15], [-22, 14], [-17, 12], [-12, 13], [-6, 12],
   [-1, 9], [4, 6], [5, -1], [4, -8], [7, -13], [10, -15], [14, -17], [19, -16], [24, -15],
   [28, -13], [31, -10], [33, -8], [35, -6], [37, 0]],
  // Madagascar
  [[-12, 49], [-16, 50], [-21, 48], [-25, 47], [-24, 44], [-19, 44], [-15, 46]],
  // Arabia and the Levant — overlaps the Asia ring below, which costs
  // nothing: `isLand` short-circuits on the first ring that contains a point
  [[37, 44], [32, 48], [30, 49], [27, 51], [25, 57], [23, 60], [19, 58], [15, 53], [13, 45],
   [16, 42], [21, 39], [26, 35], [30, 34], [32, 36], [36, 37], [37, 41]],
  // Asia — India and the southeast coast up through Siberia, stopping at 180
  [[70, 45], [73, 70], [75, 90], [73, 113], [71, 130], [70, 145], [68, 160], [66, 175],
   [62, 179], [60, 163], [57, 156], [54, 142], [50, 140], [45, 135], [42, 131], [39, 127],
   [36, 120], [31, 122], [25, 119], [22, 113], [18, 109], [12, 109], [9, 105], [7, 100],
   [10, 98], [14, 98], [16, 94], [21, 92], [22, 89], [19, 85], [15, 80], [11, 79], [8, 77],
   [13, 74], [18, 72], [22, 69], [24, 67], [28, 62], [30, 57], [33, 53], [36, 50], [40, 45],
   [45, 48], [50, 53], [55, 58], [60, 55], [66, 48]],
  // The southeast Asian archipelago, drawn as one blob and left to the
  // dither to break into something island-shaped
  [[6, 95], [6, 120], [0, 130], [-8, 140], [-10, 125], [-8, 110], [-6, 105], [-2, 100]],
  // Australia
  [[-11, 131], [-12, 137], [-15, 145], [-20, 149], [-25, 153], [-32, 152], [-38, 146],
   [-38, 141], [-35, 138], [-32, 134], [-33, 124], [-35, 117], [-31, 115], [-26, 113],
   [-22, 114], [-18, 122], [-14, 127]],
  // New Zealand
  [[-35, 173], [-38, 178], [-42, 175], [-45, 171], [-47, 167], [-44, 168], [-40, 172]],
  // Japan
  [[45, 142], [43, 145], [41, 141], [38, 141], [35, 140], [34, 136], [33, 131], [31, 130],
   [33, 129], [35, 133], [37, 137], [40, 140], [43, 140]],
];

/** Ray casting along the line of latitude — see the antimeridian note above
 * for the one shape of polygon this cannot handle. */
function pointInPolygon(lat, lon, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i];
    const [yj, xj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function isLand(lat, lon) {
  for (const poly of LAND) if (pointInPolygon(lat, lon, poly)) return true;
  return false;
}

/** The classic 4×4 ordered dither matrix. Used for two things at once here:
 * which ocean dots survive at all, and which land dots are drawn a size up —
 * so the sphere gets a stippled texture out of the same threshold rather
 * than out of a second random pass, which would shimmer as it rotates
 * (`Math.random()` per frame) or need its own stored value per dot. */
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

const STEP = 3.4;
const OCEAN_KEEP = 0.22; // roughly a fifth of ocean dots survive
const LAT_MIN = -56; // Antarctica is omitted: it is a white band that
const LAT_MAX = 80; //  carries no visitors and unbalances the silhouette

/**
 * Every dot on the sphere, as unit vectors in a Y-up frame, built once at
 * module load — the grid is fixed, so there is no reason to re-walk it each
 * time a globe mounts.
 *
 * Longitude is stepped by `STEP / cos(lat)` rather than by `STEP`, or the
 * dots would bunch tighter and tighter toward the poles and the sphere
 * would read as a wireframe cage instead of an evenly stippled ball. The
 * `max(0.25, …)` floor stops that division running away in the last few
 * degrees.
 */
export const DOTS = (() => {
  const dots = [];
  for (let lat = LAT_MIN; lat <= LAT_MAX; lat += STEP) {
    const lonStep = STEP / Math.max(0.25, Math.cos(lat * DEG2RAD));
    let col = 0;
    const row = Math.abs(Math.round(lat / STEP)) & 3;
    for (let lon = -180; lon < 180; lon += lonStep, col++) {
      const land = isLand(lat, lon);
      const bayer = BAYER[row][col & 3] / 16;
      if (!land && bayer >= OCEAN_KEEP) continue;
      const phi = (90 - lat) * DEG2RAD;
      const theta = lon * DEG2RAD;
      // Axis convention, and it matters: `z` points at the viewer and `x`
      // runs across the screen, so longitude 0 sits at the centre of the
      // disc rather than on its limb. Swap the two and the sphere still
      // draws — but the occlusion test then hides the hemisphere that is
      // facing you, which is a quarter turn out and very hard to see by
      // eye. `web/lib/globe.js` builds its pin vectors the same way; the
      // two must agree exactly or pins drift off the land under them.
      dots.push({
        x: Math.sin(phi) * Math.sin(theta),
        y: Math.cos(phi),
        z: Math.sin(phi) * Math.cos(theta),
        land,
        big: bayer < 0.5,
      });
    }
  }
  return dots;
})();
