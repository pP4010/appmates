/**
 * Image header parsing — the browser counterpart of `core/services/image_validator.read_facts`.
 *
 * Both sides read container headers and never decode pixels. That is not just an
 * optimisation: the rule that matters ("does this file carry an alpha channel?")
 * is a property of the encoding, not of the pixels. A fully opaque RGBA PNG is
 * still rejected by App Store Connect, so sampling pixels on a canvas would give
 * the wrong answer. The PNG colour-type byte gives the right one.
 *
 * Reading headers also means a 3 MB screenshot costs a few bytes of work, so a
 * directory of screenshots validates instantly with nothing leaving the machine.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// PNG colour types that carry per-pixel alpha (4 = grey+alpha, 6 = truecolour+alpha).
const PNG_ALPHA_COLOUR_TYPES = new Set([4, 6]);

const PNG_COLOUR_TYPE_MODES = {
  0: 'L', // greyscale
  2: 'RGB',
  3: 'P', // palette
  4: 'LA',
  6: 'RGBA',
};

/** JPEG Start-Of-Frame markers holding dimensions. Excludes DHT/DAC/RST/SOS. */
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

export class UnreadableImageError extends Error {}

function hasPngSignature(bytes) {
  return PNG_SIGNATURE.every((byte, i) => bytes[i] === byte);
}

/**
 * Walk PNG chunks looking for transparency declared outside the colour type.
 *
 * A palette PNG (colour type 3) stores its alpha in a separate tRNS chunk, so
 * the colour-type byte alone would report "no alpha" for an image the stores
 * will reject. Pillow surfaces the same thing as `info["transparency"]`.
 */
function pngHasTransparencyChunk(view, bytes) {
  let offset = 8; // past the signature
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    if (type === 'tRNS') return true;
    // IDAT starts the pixel data; tRNS is required to appear before it.
    if (type === 'IDAT' || type === 'IEND') return false;
    offset += 12 + length; // length + type + data + CRC
  }
  return false;
}

function readPng(view, bytes, sizeBytes) {
  if (bytes.length < 26) {
    throw new UnreadableImageError('PNG header is truncated');
  }
  const colourType = bytes[25];
  const hasAlpha =
    PNG_ALPHA_COLOUR_TYPES.has(colourType) || pngHasTransparencyChunk(view, bytes);

  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    imageFormat: 'PNG',
    mode: PNG_COLOUR_TYPE_MODES[colourType] ?? `unknown(${colourType})`,
    hasAlpha,
    sizeBytes,
  };
}

/**
 * Scan JPEG segments for the frame header.
 *
 * JPEG has no alpha channel in any baseline or progressive form, so `hasAlpha`
 * is structurally false rather than parsed. The component count in SOF does
 * distinguish CMYK (4 components), which both stores reject.
 */
function readJpeg(view, bytes, sizeBytes) {
  let offset = 2; // past SOI
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1; // resynchronise on fill bytes
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // standalone markers carry no payload
      continue;
    }
    const segmentLength = view.getUint16(offset + 2);

    if (JPEG_SOF_MARKERS.has(marker)) {
      const components = bytes[offset + 9];
      return {
        width: view.getUint16(offset + 7),
        height: view.getUint16(offset + 5),
        imageFormat: 'JPEG',
        mode: components === 4 ? 'CMYK' : components === 1 ? 'L' : 'RGB',
        hasAlpha: false,
        sizeBytes,
      };
    }
    if (marker === 0xda) break; // start of scan: no frame header found
    offset += 2 + segmentLength;
  }
  throw new UnreadableImageError('JPEG frame header not found');
}

/**
 * Extract image facts from raw bytes.
 *
 * @param {ArrayBuffer} buffer  the file's leading bytes (a few KB is plenty)
 * @param {number} sizeBytes    the file's full size on disk
 * @returns {{width:number,height:number,imageFormat:string,mode:string,hasAlpha:boolean,sizeBytes:number}}
 */
export function readFactsFromBuffer(buffer, sizeBytes) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  if (bytes.length < 4) {
    throw new UnreadableImageError('File is too small to be an image');
  }
  if (hasPngSignature(bytes)) {
    return readPng(view, bytes, sizeBytes);
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return readJpeg(view, bytes, sizeBytes);
  }
  throw new UnreadableImageError('Not a PNG or JPEG file');
}

/**
 * Read facts from a File or Blob.
 *
 * Only the first 64 KB is read: enough for a PNG's chunk preamble and any
 * realistic JPEG segment run, while never pulling a multi-megabyte screenshot
 * into memory.
 */
export async function readFacts(file) {
  const head = file.slice(0, 65536);
  const buffer = await head.arrayBuffer();
  return readFactsFromBuffer(buffer, file.size);
}

/** Long side divided by short side, mirroring `ImageFacts.aspect_ratio`. */
export function aspectRatio(facts) {
  if (!facts.width || !facts.height) return 0;
  const lo = Math.min(facts.width, facts.height);
  const hi = Math.max(facts.width, facts.height);
  return Math.round((hi / lo) * 10000) / 10000;
}
