/**
 * Canvas-based repair — the browser counterpart of `core/services/image_fixer.ScreenshotFixer`.
 *
 * Output is always JPEG, and that is a correctness decision rather than a
 * preference. `canvas.toBlob('image/png')` emits a 32-bit RGBA PNG even when
 * every pixel is opaque, so a "fixed" PNG would still carry the alpha channel
 * that got the screenshot rejected in the first place. JPEG cannot represent
 * alpha at all, so the output is guaranteed clean. Both stores accept JPEG.
 *
 * The CLI writes real alpha-free PNGs via Pillow; that path stays available for
 * anyone who needs PNG specifically.
 */

const JPEG_QUALITY = 0.92;

/** Which spec size an image should become. Mirrors `_resolve_target`. */
export function resolveTarget(spec, facts, explicitId = null) {
  const byId = (id) => spec.sizes.find((s) => s.id === id) ?? null;

  if (explicitId) return byId(explicitId);

  const portrait = (s) => [Math.min(s.width, s.height), Math.max(s.width, s.height)];
  const pw = Math.min(facts.width, facts.height);
  const ph = Math.max(facts.width, facts.height);

  const matches = spec.sizes.filter((s) => {
    const [w, h] = portrait(s);
    return w === pw && h === ph;
  });
  const current = matches.find((s) => s.status === 'required' || s.status === 'accepted');
  if (current) return null; // already a good size

  const legacy = matches[0];
  if (legacy?.supersedes) return byId(legacy.supersedes);

  const candidates = spec.sizes.filter(
    (s) => s.status === 'required' || s.status === 'accepted',
  );
  if (candidates.length === 0) return null;

  return candidates.reduce((best, s) => {
    const [sw, sh] = portrait(s);
    const [bw, bh] = portrait(best);
    return Math.abs(sw - pw) + Math.abs(sh - ph) < Math.abs(bw - pw) + Math.abs(bh - ph)
      ? s
      : best;
  });
}

/** Match the source orientation so landscape input stays landscape. */
export function orientedTarget(size, facts) {
  const short = Math.min(size.width, size.height);
  const long = Math.max(size.width, size.height);
  return facts.width > facts.height ? [long, short] : [short, long];
}

/**
 * Describe what would change, without touching pixels.
 * Mirrors `ScreenshotFixer.plan_file`.
 */
export function planFix(spec, facts, { explicitTargetId = null, background = '#FFFFFF' } = {}) {
  const actions = [];

  if (facts.hasAlpha) {
    actions.push({ code: 'FLATTEN_ALPHA', detail: `flatten ${facts.mode} onto ${background}` });
  }
  if (facts.mode !== 'RGB' && facts.mode !== 'L') {
    actions.push({ code: 'CONVERT_RGB', detail: `convert ${facts.mode} to RGB` });
  }

  const target = resolveTarget(spec, facts, explicitTargetId);
  let targetSize = null;
  if (target) {
    const [w, h] = orientedTarget(target, facts);
    if (w !== facts.width || h !== facts.height) {
      targetSize = [w, h];
      actions.push({
        code: 'RESIZE',
        detail: `${facts.width}x${facts.height} → ${w}x${h} (${target.device_class})`,
      });
    }
  }

  const limit = spec.rules.max_bytes;
  if (limit != null && facts.sizeBytes > limit) {
    actions.push({
      code: 'RECOMPRESS',
      detail: `${(facts.sizeBytes / 1048576).toFixed(1)} MB → under ${Math.round(limit / 1048576)} MB`,
    });
  }

  // Re-encoding to JPEG is itself a change worth showing when nothing else applies.
  if (actions.length === 0 && facts.imageFormat !== 'JPEG') {
    return { actions: [], targetSize: null, changed: false };
  }

  return { actions, targetSize, changed: actions.length > 0 };
}

/**
 * Produce the repaired image.
 *
 * Scales to fit inside the target and pads with the background colour rather
 * than stretching: a distorted UI screenshot reads as broken to reviewers.
 *
 * @returns {Promise<{blob: Blob, name: string, width: number, height: number}>}
 */
export async function applyFix(file, facts, plan, { background = '#FFFFFF' } = {}) {
  const bitmap = await createImageBitmap(file);
  try {
    const [width, height] = plan.targetSize ?? [facts.width, facts.height];

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });

    // Fill first: this is what removes the transparency, and what the padding
    // around a letterboxed image shows.
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);

    const scale = Math.min(width / bitmap.width, height / bitmap.height);
    const drawWidth = Math.max(1, Math.round(bitmap.width * scale));
    const drawHeight = Math.max(1, Math.round(bitmap.height * scale));

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      bitmap,
      Math.floor((width - drawWidth) / 2),
      Math.floor((height - drawHeight) / 2),
      drawWidth,
      drawHeight,
    );

    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
    );

    return {
      blob,
      name: file.name.replace(/\.(png|jpe?g)$/i, '') + '.jpg',
      width,
      height,
    };
  } finally {
    bitmap.close();
  }
}
