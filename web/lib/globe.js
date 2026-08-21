/**
 * The sponsor page's live visitor globe: an orthographic dot-sphere on a
 * plain 2D canvas, draggable, with a pin per country anyone is currently
 * reading from.
 *
 * No WebGL and no library — `web/` has no bundler and pulls in no
 * third-party JS anywhere. The land mask lives in `globe-land.js`, which
 * pre-samples it into ~1,500 unit vectors at module load; per frame this
 * only rotates and projects them, which is cheap enough for a phone. Pins
 * are country centroids and nothing finer: the server never sends a
 * coordinate (see `community/src/routes/presence.js`), so there is nothing
 * here that could accidentally become precise.
 */

import { DOTS } from './globe-land.js';
import { CENTROIDS, flagFor, countryName } from './globe-centroids.js';

const DEG2RAD = Math.PI / 180;
const SPIN_DEG_PER_SEC = 4.2;
/** How long a pin stays "fresh" — pulsing, and drawn as still here. */
const FRESH_SECONDS = 300;
/** Idle time after the last pointer event before the globe resumes
 * spinning, so it doesn't lurch away the instant a hover ends. */
const RESUME_SPIN_MS = 4000;
/** ~30fps. A 4.2°/s drift and a slow pulse cannot show the difference, and
 * halving the frame budget matters more on the phones this has to run on. */
const FRAME_MS = 28;
const MAX_PITCH = 70;
const DRAG_SENSITIVITY = 0.35;
const TIP_TOUCH_MS = 3500;

/* ============================ theme ============================ */

/** Parses whatever a CSS custom property happens to hold into `{r,g,b}`.
 * The tokens in `styles.css` are all `#rrggbb` today, but a token is a
 * string someone can edit — falling back to a visible neutral is much
 * better than leaving `fillStyle` unset and painting the last colour used. */
function parseColor(value, fallback) {
  const text = (value || '').trim();
  let m = text.match(/^#([0-9a-f]{3})$/i);
  if (m) {
    const [r, g, b] = [...m[1]].map((c) => parseInt(c + c, 16));
    return { r, g, b };
  }
  m = text.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  m = text.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (m) return { r: +m[1], g: +m[2], b: +m[3] };
  return fallback;
}

const rgba = (c, a) => `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;

/* ============================ mount ============================ */

/**
 * Mounts a globe into `canvas`. `tip` is the tooltip element, passed in
 * rather than created here — this module makes no DOM, so the tooltip's
 * markup stays in `index.html` and its styling in `landing.css` with the
 * rest of the page.
 *
 * Returns `{ start, stop, destroy, setSnapshot }`. `setSnapshot` takes the
 * `{ pins, feed }` shape `/presence/globe` answers with.
 */
export function mountGlobe(canvas, { tip } = {}) {
  const ctx = canvas.getContext('2d');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const coarse = window.matchMedia('(pointer: coarse)').matches;

  let size = 0;
  let radius = 0;
  let centre = 0;

  // Start over the Atlantic: the Americas and Europe/Africa are both in
  // view, which is where most of the traffic is.
  let yaw = -20;
  let pitch = 22;

  let pins = [];
  let feedByCountry = new Map();
  let hasFresh = false;
  let hoverPin = null;

  let dragging = false;
  let hovering = false;
  let lastPointerAt = -Infinity;
  let dragX = 0;
  let dragY = 0;
  let tipTimer = null;

  let started = false;
  let onScreen = false;
  let rafId = null;
  let lastFrame = 0;
  /** Something changed while the loop wasn't animating — a hover, a new
   * snapshot, a theme flip, a resize. Without this the "paused" globe would
   * either repaint identical frames forever or miss the one frame that
   * actually differs. */
  let dirty = true;

  let theme = null;

  function readTheme() {
    const root = getComputedStyle(document.documentElement);
    const get = (name, fallback) => parseColor(root.getPropertyValue(name), fallback);
    theme = {
      land: get('--text-2', { r: 85, g: 85, b: 95 }),
      ocean: get('--muted', { r: 138, g: 138, b: 151 }),
      rim: get('--border', { r: 228, g: 228, b: 236 }),
      pin: get('--accent', { r: 84, g: 87, b: 214 }),
    };
  }

  /* ---------- layout ---------- */

  /** Assigning `canvas.width` resets the bitmap — even to the same value —
   * so this always repaints before returning. The animation loop cannot be
   * relied on to do it: it is gated on the globe being on screen in a
   * visible tab, and a resize that lands while either is false would
   * otherwise leave a blank ball sitting there until something else woke
   * the loop up. */
  function resize() {
    const box = canvas.getBoundingClientRect();
    const next = Math.round(box.width) || size || 320;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    size = next;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    canvas.style.height = `${size}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    radius = size * 0.46;
    centre = size / 2;
    draw(performance.now());
  }

  /* ---------- projection ---------- */

  /** Yaw about the vertical axis, then pitch about the horizontal one;
   * orthographic, so `z` doubles as both the depth cue and the occlusion
   * test. Pins run through the exact same transform as the land dots, which
   * is the only way the two can never drift apart. */
  function project(p, sinYaw, cosYaw, sinPitch, cosPitch) {
    const x1 = p.x * cosYaw - p.z * sinYaw;
    const z1 = p.x * sinYaw + p.z * cosYaw;
    const y2 = p.y * cosPitch - z1 * sinPitch;
    const z2 = p.y * sinPitch + z1 * cosPitch;
    return { sx: centre + radius * x1, sy: centre - radius * y2, z: z2 };
  }

  /** Rebuilt on every draw, hit-tested by the hover handler. */
  const pinScreen = [];

  function draw(t) {
    if (!theme) readTheme();
    ctx.clearRect(0, 0, size, size);

    const sinYaw = Math.sin(yaw * DEG2RAD);
    const cosYaw = Math.cos(yaw * DEG2RAD);
    const sinPitch = Math.sin(pitch * DEG2RAD);
    const cosPitch = Math.cos(pitch * DEG2RAD);

    ctx.strokeStyle = rgba(theme.rim, 1);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(centre, centre, radius + 4, 0, Math.PI * 2);
    ctx.stroke();

    // Dot sizes were tuned against a 220px radius; everything scales off it.
    const k = radius / 220;

    for (const dot of DOTS) {
      const p = project(dot, sinYaw, cosYaw, sinPitch, cosPitch);
      if (p.z <= 0.02) continue; // far hemisphere — cheap occlusion, no depth buffer
      if (dot.land) {
        // Squares, not arcs: 1,500 `fillRect`s cost a fraction of 1,500
        // `arc`s, and the hard pixel edge is exactly what stops the sphere
        // reading as a smudge at this size.
        const r = (1.05 + 0.8 * p.z) * (dot.big ? 1.22 : 0.92) * k;
        ctx.fillStyle = rgba(theme.land, 0.3 + 0.62 * p.z);
        ctx.fillRect(p.sx - r, p.sy - r, r * 2, r * 2);
      } else {
        const r = 0.9 * k;
        ctx.fillStyle = rgba(theme.ocean, 0.08 + 0.13 * p.z);
        ctx.fillRect(p.sx - r, p.sy - r, r * 2, r * 2);
      }
    }

    pinScreen.length = 0;
    for (const pin of pins) {
      const p = project(pin, sinYaw, cosYaw, sinPitch, cosPitch);
      if (p.z <= 0.05) continue;
      const fresh = pin.ago < FRESH_SECONDS;
      // log2, not linear: one visitor and forty visitors have to be
      // distinguishable without the second one swallowing the continent.
      const base = (2.2 + Math.min(2.6, Math.log2(1 + pin.n))) * k;
      const pulse = fresh && !reduced ? 1 + 0.35 * Math.sin(t / 350 + pin.x * 7) : 1;
      const hot = hoverPin === pin;

      ctx.fillStyle = rgba(theme.pin, 0.16);
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, base * 2.4 * pulse, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = rgba(theme.pin, hot ? 1 : 0.95);
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, base * (hot ? 1.25 : 1), 0, Math.PI * 2);
      ctx.fill();

      pinScreen.push({ pin, sx: p.sx, sy: p.sy, r: base * 2.4 });
    }
  }

  /* ---------- loop ---------- */

  function visible() {
    return started && onScreen && document.visibilityState !== 'hidden';
  }

  function loop(t) {
    rafId = null;
    if (!visible()) return;
    rafId = requestAnimationFrame(loop);

    if (!dragging && t - lastFrame < FRAME_MS) return;
    const dt = t - lastFrame;
    lastFrame = t;

    const spinning = !dragging && !hovering && performance.now() - lastPointerAt > RESUME_SPIN_MS;
    // `yaw` is the longitude at the centre of the disc, so counting it down
    // walks the surface eastward across the screen — the direction Earth
    // actually appears to turn with north up and east to the right.
    if (spinning) yaw = (yaw - (SPIN_DEG_PER_SEC * dt) / 1000) % 360;

    // Held still, nothing pulsing, nothing changed: the next frame would be
    // pixel-identical, so don't paint it.
    if (!spinning && !dragging && !hasFresh && !dirty) return;
    dirty = false;
    draw(t);
  }

  /** Wakes the loop if it is allowed to run, and otherwise paints exactly
   * one frame. The second half is what keeps a paused globe honest: a new
   * snapshot arriving while the section is scrolled away, the tab is in the
   * background, or reduced motion is on would otherwise sit unpainted, and
   * the reader would come back to the pins from a minute ago. */
  function kick() {
    if (!reduced && rafId == null && visible()) {
      lastFrame = performance.now();
      rafId = requestAnimationFrame(loop);
      return;
    }
    if (rafId == null) draw(performance.now());
  }

  /* ---------- tooltip ---------- */

  function agoLabel(seconds) {
    if (seconds == null || seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    return `${Math.floor(seconds / 3600)}h ago`;
  }

  function showTip(pin, clientX, clientY) {
    if (!tip) return;
    const head = `${flagFor(pin.c)} ${countryName(pin.c)}`;
    const count = pin.n > 1 ? `${pin.n} people here right now` : 'here right now';
    const latest = feedByCountry.get(pin.c);
    const lines = [`<b>${head}</b>`, `<span>${count}</span>`];
    if (latest) {
      const where = latest.pageLabel ? `reading ${latest.pageLabel}` : 'reading the site';
      lines.push(`<span>${where}${latest.device ? ` · ${latest.device}` : ''}</span>`);
    }
    lines.push(`<span>${agoLabel(pin.ago)}</span>`);
    tip.innerHTML = lines.join('<br>');
    tip.hidden = false;

    const box = tip.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(clientX + 14, window.innerWidth - box.width - 10))}px`;
    tip.style.top = `${Math.max(8, clientY - box.height - 12)}px`;
  }

  function hideTip() {
    if (tip) tip.hidden = true;
    clearTimeout(tipTimer);
  }

  function hitPin(x, y) {
    let best = null;
    let bestDist = Infinity;
    for (const entry of pinScreen) {
      const dx = x - entry.sx;
      const dy = y - entry.sy;
      const dist = dx * dx + dy * dy;
      const reach = Math.max(entry.r + 6, 10) ** 2;
      if (dist < reach && dist < bestDist) {
        best = entry;
        bestDist = dist;
      }
    }
    return best;
  }

  /* ---------- interaction ---------- */

  function onPointerDown(event) {
    dragging = true;
    lastPointerAt = performance.now();
    dragX = event.clientX;
    dragY = event.clientY;
    canvas.style.cursor = 'grabbing';
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      /* a pointer that vanished between events — nothing to capture */
    }
  }

  function onPointerMove(event) {
    lastPointerAt = performance.now();
    if (dragging) {
      // Minus, so the surface follows the finger: `yaw` is the longitude at
      // the centre of the disc, and dragging right has to bring westward
      // longitudes into view, not eastward ones.
      yaw -= (event.clientX - dragX) * DRAG_SENSITIVITY;
      pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch + (event.clientY - dragY) * DRAG_SENSITIVITY));
      dragX = event.clientX;
      dragY = event.clientY;
      hideTip();
      dirty = true;
      if (reduced) draw(performance.now());
      return;
    }

    hovering = true;
    const box = canvas.getBoundingClientRect();
    const hit = hitPin(event.clientX - box.left, event.clientY - box.top);
    if ((hit ? hit.pin : null) !== hoverPin) dirty = true;
    hoverPin = hit ? hit.pin : null;
    canvas.style.cursor = hit ? 'pointer' : 'grab';
    if (hit) showTip(hit.pin, event.clientX, event.clientY);
    else hideTip();
    if (reduced) draw(performance.now());
  }

  function onPointerUp(event) {
    dragging = false;
    lastPointerAt = performance.now();
    canvas.style.cursor = 'grab';
    // A tap that wasn't really a drag: touch has no hover, so this is the
    // only way a pin's detail is reachable on a phone.
    if (coarse || event.pointerType !== 'mouse') {
      const box = canvas.getBoundingClientRect();
      const hit = hitPin(event.clientX - box.left, event.clientY - box.top);
      if (hit) {
        showTip(hit.pin, event.clientX, event.clientY);
        clearTimeout(tipTimer);
        tipTimer = setTimeout(hideTip, TIP_TOUCH_MS);
      }
    }
  }

  function onPointerCancel() {
    dragging = false;
    lastPointerAt = performance.now();
    canvas.style.cursor = 'grab';
  }

  function onPointerLeave() {
    hovering = false;
    if (hoverPin) dirty = true;
    hoverPin = null;
    hideTip();
    canvas.style.cursor = 'grab';
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('pointerleave', onPointerLeave);

  /* ---------- environment ---------- */

  const io = new IntersectionObserver(
    (entries) => {
      onScreen = entries[0].isIntersecting;
      if (onScreen) kick();
    },
    { rootMargin: '120px' },
  );

  function onVisibility() {
    if (document.visibilityState !== 'hidden') kick();
  }
  document.addEventListener('visibilitychange', onVisibility);

  // There is no `data-theme` attribute anywhere in `web/` — the palette
  // flips purely through `@media (prefers-color-scheme: dark)` in
  // styles.css, so this query, not a MutationObserver, is the hook.
  function onThemeChange() {
    readTheme();
    dirty = true;
    if (reduced) draw(performance.now());
  }
  darkQuery.addEventListener('change', onThemeChange);

  // Width only: a mobile URL bar collapsing fires a height-only resize on
  // every scroll, and re-initing the canvas for those reads as a flicker.
  let resizeTimer = null;
  let lastWidth = window.innerWidth;
  function onResize() {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resize(); // repaints on its own — see the note there
      dirty = true;
    }, 200);
  }
  window.addEventListener('resize', onResize);

  canvas.style.cursor = 'grab';
  // pan-y: a horizontal drag rotates the globe, a vertical one still
  // scrolls the page. A canvas in the middle of a page must never trap the
  // scroll.
  canvas.style.touchAction = 'pan-y';

  return {
    /** Call once the sponsor view is un-hidden. `IntersectionObserver`
     * cannot be the only gate: `#sponsorView[hidden]` gives this canvas a
     * `display: none` ancestor, so IO reports `isIntersecting: false` and
     * would keep the globe dark after un-hiding until a scroll nudged it.
     * Observing here — after the element has a box — is what makes the
     * first frame land. */
    start() {
      if (started) return;
      started = true;
      readTheme();
      resize(); // measures, and paints the first frame — never blank on arrival
      dirty = true;
      io.observe(canvas);
    },

    stop() {
      started = false;
      io.unobserve(canvas);
      if (rafId != null) cancelAnimationFrame(rafId);
      rafId = null;
      hideTip();
    },

    destroy() {
      this.stop();
      io.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      document.removeEventListener('visibilitychange', onVisibility);
      darkQuery.removeEventListener('change', onThemeChange);
      window.removeEventListener('resize', onResize);
      clearTimeout(resizeTimer);
      clearTimeout(tipTimer);
    },

    /** `{ pins: [{ c, n, ago }], feed: [{ c, pageLabel, device, ago }] }` —
     * the feed is only used to give a hovered pin a sentence, so it is
     * indexed by country here rather than scanned per hover. */
    setSnapshot({ pins: nextPins = [], feed = [] } = {}) {
      pins = nextPins
        .map((pin) => {
          const centroid = CENTROIDS[pin.c];
          if (!centroid) return null; // unlisted code — skipped, never drawn at [0,0]
          const phi = (90 - centroid[0]) * DEG2RAD;
          const theta = centroid[1] * DEG2RAD;
          // Same axis convention as `globe-land.js` — see the note there.
          return {
            ...pin,
            x: Math.sin(phi) * Math.sin(theta),
            y: Math.cos(phi),
            z: Math.sin(phi) * Math.cos(theta),
          };
        })
        .filter(Boolean);

      feedByCountry = new Map();
      for (const entry of feed) {
        if (entry.c && !feedByCountry.has(entry.c)) feedByCountry.set(entry.c, entry);
      }

      // Checked per payload, not per frame — it decides whether the loop is
      // allowed to skip repaints entirely.
      hasFresh = pins.some((pin) => pin.ago < FRESH_SECONDS);
      hoverPin = null;
      dirty = true;
      kick();
    },
  };
}
