/**
 * Minimal ZIP writer, stored (uncompressed) entries only.
 *
 * Exists so "download all fixed screenshots" is a single file. Triggering one
 * download per screenshot gets throttled or blocked by browsers once past the
 * first couple, and a batch of ten is the normal case here.
 *
 * Store-only is the right trade: the payload is JPEG, already entropy-coded, so
 * deflating it would cost CPU for roughly nothing. That keeps this to a header
 * writer with no compression dependency.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Convert a Date into the DOS date/time pair ZIP headers use. */
function dosDateTime(date) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f);
  const day =
    ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

class ByteWriter {
  constructor() {
    this.parts = [];
    this.length = 0;
  }

  bytes(data) {
    this.parts.push(data);
    this.length += data.length;
  }

  u16(value) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, value, true);
    this.bytes(b);
  }

  u32(value) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, value >>> 0, true);
    this.bytes(b);
  }
}

/**
 * Reduce a filename to plain ASCII.
 *
 * Entries are flagged UTF-8 and correct per the spec — Python's zipfile, Finder
 * and Windows Explorer all read accented names back exactly. But the Info-ZIP
 * `unzip` that ships with macOS predates that flag and mangles such names into
 * unwritable garbage. "écran-1.jpg" is an entirely normal filename for a
 * French-speaking developer, so the archive transliterates rather than betting
 * on the user's unzip being recent.
 */
export function safeName(name) {
  const clean = (part) =>
    part
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // strip combining accents
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '');

  const segments = name.split('/');
  const base = segments.pop() ?? '';
  const dir = segments.map(clean).filter(Boolean);

  const dot = base.lastIndexOf('.');
  const rawStem = dot > 0 ? base.slice(0, dot) : base;
  const rawExt = dot > 0 ? base.slice(dot + 1) : '';

  // A name written entirely in a non-Latin script sanitises to nothing. Falling
  // back on the whole basename would yield ".jpg" — a hidden, nameless file, and
  // one that collides with every other such file in the archive.
  const stem = clean(rawStem) || 'screenshot';
  const ext = clean(rawExt);

  return [...dir, ext ? `${stem}.${ext}` : stem].join('/');
}

/**
 * Make every name unique, preserving order.
 *
 * Transliteration can map distinct names onto the same result, and a ZIP with
 * duplicate entries silently loses files on extraction.
 */
export function uniqueNames(names) {
  const seen = new Map();
  return names.map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count === 0) return name;

    const dot = name.lastIndexOf('.');
    return dot > 0
      ? `${name.slice(0, dot)}-${count + 1}${name.slice(dot)}`
      : `${name}-${count + 1}`;
  });
}

/**
 * Build a ZIP archive.
 *
 * @param {{name: string, data: Uint8Array}[]} files
 * @returns {Blob}
 */
export function createZip(files) {
  const encoder = new TextEncoder();
  const { time, day } = dosDateTime(new Date());

  const out = new ByteWriter();
  const central = [];

  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.data);
    const offset = out.length;

    out.u32(0x04034b50); // local file header signature
    out.u16(20); // version needed
    out.u16(0x0800); // flags: UTF-8 filenames
    out.u16(0); // method: stored
    out.u16(time);
    out.u16(day);
    out.u32(crc);
    out.u32(file.data.length); // compressed size
    out.u32(file.data.length); // uncompressed size
    out.u16(name.length);
    out.u16(0); // extra field length
    out.bytes(name);
    out.bytes(file.data);

    central.push({ name, crc, size: file.data.length, offset });
  }

  const centralStart = out.length;
  for (const entry of central) {
    out.u32(0x02014b50); // central directory header signature
    out.u16(20); // version made by
    out.u16(20); // version needed
    out.u16(0x0800);
    out.u16(0);
    out.u16(time);
    out.u16(day);
    out.u32(entry.crc);
    out.u32(entry.size);
    out.u32(entry.size);
    out.u16(entry.name.length);
    out.u16(0); // extra
    out.u16(0); // comment
    out.u16(0); // disk number start
    out.u16(0); // internal attributes
    out.u32(0); // external attributes
    out.u32(entry.offset);
    out.bytes(entry.name);
  }
  const centralSize = out.length - centralStart;

  out.u32(0x06054b50); // end of central directory
  out.u16(0);
  out.u16(0);
  out.u16(central.length);
  out.u16(central.length);
  out.u32(centralSize);
  out.u32(centralStart);
  out.u16(0); // comment length

  return new Blob(out.parts, { type: 'application/zip' });
}
