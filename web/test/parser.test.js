/**
 * The JS header parser must read the same facts Pillow reads.
 *
 * Rules are only as correct as the facts they run on. `conformance.test.js`
 * proves the rule engines agree given identical facts; this proves the two
 * sides derive identical facts from identical bytes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { readFactsFromBuffer, aspectRatio, UnreadableImageError } from '../lib/image-facts.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, 'fixtures');
const manifest = JSON.parse(readFileSync(join(fixtureDir, 'fixtures.json'), 'utf8'));

function factsFor(name) {
  const buffer = readFileSync(join(fixtureDir, name));
  const copy = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return readFactsFromBuffer(copy, buffer.byteLength);
}

test('parsed facts match Pillow for every fixture', () => {
  for (const expected of manifest.fixtures) {
    const actual = factsFor(expected.file);

    assert.equal(actual.width, expected.width, `${expected.file} width`);
    assert.equal(actual.height, expected.height, `${expected.file} height`);
    assert.equal(actual.imageFormat, expected.imageFormat, `${expected.file} format`);
    assert.equal(actual.hasAlpha, expected.hasAlpha, `${expected.file} alpha`);
    assert.equal(actual.sizeBytes, expected.sizeBytes, `${expected.file} size`);
  }
});

test('colour mode matches Pillow where the container encodes it', () => {
  // JPEG has no notion of Pillow's "P" mode and stores only a component count,
  // so mode is inferred rather than read; PNG encodes it exactly.
  for (const expected of manifest.fixtures.filter((f) => f.imageFormat === 'PNG')) {
    assert.equal(factsFor(expected.file).mode, expected.mode, `${expected.file} mode`);
  }
});

test('palette transparency is detected from the tRNS chunk', () => {
  // The colour-type byte alone reports "no alpha" here; only chunk walking finds it.
  const facts = factsFor('palette-trns.png');
  assert.equal(facts.mode, 'P');
  assert.equal(facts.hasAlpha, true);
});

test('metadata chunks before IDAT do not confuse the parser', () => {
  const facts = factsFor('rgb-with-text.png');
  assert.equal(facts.width, 48);
  assert.equal(facts.hasAlpha, false);
});

test('CMYK JPEG is reported as CMYK so the colour-space rule can fire', () => {
  assert.equal(factsFor('cmyk.jpg').mode, 'CMYK');
});

test('aspect ratio is orientation independent', () => {
  const wide = factsFor('wide.jpg');
  assert.equal(wide.width > wide.height, true);
  assert.equal(aspectRatio(wide), aspectRatio({ width: wide.height, height: wide.width }));
});

test('non-image bytes raise rather than returning nonsense', () => {
  const buffer = new TextEncoder().encode('definitely not an image at all');
  assert.throws(
    () => readFactsFromBuffer(buffer.buffer, buffer.byteLength),
    UnreadableImageError,
  );
});

test('a truncated PNG raises', () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  assert.throws(() => readFactsFromBuffer(bytes.buffer, bytes.length), UnreadableImageError);
});
