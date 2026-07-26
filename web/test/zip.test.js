/**
 * ZIP writer tests.
 *
 * The archive is what a user actually receives after clicking "fix and
 * download", so a malformed header means silently handing someone a file their
 * OS refuses to open. The test writes a real archive to a temp path; CI runs
 * `unzip -t` against it afterwards to confirm a real implementation accepts it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createZip, safeName, uniqueNames } from '../lib/zip.js';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const EOCD = 0x06054b50;

function bytesOf(text) {
  return new TextEncoder().encode(text);
}

async function zipBytes(files) {
  const blob = createZip(files);
  return new Uint8Array(await blob.arrayBuffer());
}

test('produces a well-formed archive', async () => {
  const bytes = await zipBytes([
    { name: 'a.txt', data: bytesOf('hello') },
    { name: 'nested/b.txt', data: bytesOf('world') },
  ]);
  const view = new DataView(bytes.buffer);

  assert.equal(view.getUint32(0, true), LOCAL_HEADER, 'starts with a local file header');
  assert.equal(
    view.getUint32(bytes.length - 22, true),
    EOCD,
    'ends with the end-of-central-directory record',
  );
  assert.equal(view.getUint16(bytes.length - 12, true), 2, 'records two entries');
});

test('central directory offset points at a real central header', async () => {
  const bytes = await zipBytes([{ name: 'a.txt', data: bytesOf('hello') }]);
  const view = new DataView(bytes.buffer);

  const centralOffset = view.getUint32(bytes.length - 6, true);
  assert.equal(view.getUint32(centralOffset, true), CENTRAL_HEADER);
});

test('stores content verbatim', async () => {
  const payload = bytesOf('exact bytes, no compression');
  const bytes = await zipBytes([{ name: 'a.txt', data: payload }]);

  // Local header is 30 bytes plus the name; stored entries follow immediately.
  const start = 30 + 'a.txt'.length;
  assert.deepEqual(bytes.slice(start, start + payload.length), payload);
});

test('records the uncompressed size in both size fields', async () => {
  const payload = bytesOf('1234567890');
  const bytes = await zipBytes([{ name: 'a.txt', data: payload }]);
  const view = new DataView(bytes.buffer);

  assert.equal(view.getUint32(18, true), payload.length, 'compressed size');
  assert.equal(view.getUint32(22, true), payload.length, 'uncompressed size');
});

test('flags UTF-8 so non-ASCII names survive', async () => {
  const bytes = await zipBytes([{ name: 'écran-1.jpg', data: bytesOf('x') }]);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint16(6, true) & 0x0800, 0x0800);
});

test('handles an empty archive', async () => {
  const bytes = await zipBytes([]);
  assert.equal(bytes.length, 22, 'just the end-of-central-directory record');
});

test('safeName transliterates to ASCII the oldest unzip can handle', () => {
  assert.equal(safeName('écran-accueil.jpg'), 'ecran-accueil.jpg');
  assert.equal(safeName('Präsentation 1.jpg'), 'Prasentation-1.jpg');
  assert.equal(safeName('locale/fr-FR/écran.jpg'), 'locale/fr-FR/ecran.jpg');
  assert.equal(safeName('plain.jpg'), 'plain.jpg');
});

test('safeName never produces a nameless or hidden file', () => {
  // Everything sanitises away, so the stem must be replaced rather than dropped.
  assert.equal(safeName('日本語.jpg'), 'screenshot.jpg');
  assert.equal(safeName('!!!.png'), 'screenshot.png');
  assert.equal(safeName('___'), '___');
  for (const name of ['日本語.jpg', '!!!.png', '．．.jpg']) {
    assert.ok(!safeName(name).startsWith('.'), `${name} became hidden`);
  }
});

test('uniqueNames prevents collisions that would drop files', () => {
  assert.deepEqual(uniqueNames(['a.jpg', 'a.jpg', 'b.jpg', 'a.jpg']), [
    'a.jpg',
    'a-2.jpg',
    'b.jpg',
    'a-3.jpg',
  ]);
});

test('transliteration collisions are resolved, not silently merged', () => {
  // Distinct originals, identical after transliteration.
  const names = ['日本語.jpg', '한국어.jpg'].map(safeName);
  assert.deepEqual(uniqueNames(names), ['screenshot.jpg', 'screenshot-2.jpg']);
});

test('writes an archive real tools can open', async () => {
  // Consumed by the `unzip -t` step in CI: assertions above check the bytes we
  // meant to write, this checks a real implementation agrees.
  const bytes = await zipBytes([
    { name: 'screen-01.jpg', data: bytesOf('pretend jpeg payload') },
    { name: 'locale/en-US/screen-02.jpg', data: bytesOf('another payload') },
    { name: safeName('écran-accueil.jpg'), data: bytesOf('accents in the name') },
  ]);

  const dir = mkdtempSync(join(tmpdir(), 'launchpilot-zip-'));
  const path = join(dir, 'archive.zip');
  writeFileSync(path, bytes);

  // Printed so CI can pick the path up for the external check.
  console.log(`ZIP_FIXTURE=${path}`);
  assert.ok(bytes.length > 22);
});
