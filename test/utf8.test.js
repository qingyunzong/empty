import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createPack, addDictionary, appendLabels } from '../src/writer.js';
import { decodeBuffer, collect, IncrementalDecoder } from '../src/reader.js';
import { tmpDir, sampleLabels, sampleDictValues, WS_MULTIBYTE } from '../testutil/helpers.js';

function buildPack() {
  const dir = tmpDir();
  createPack(dir);
  addDictionary(dir, sampleDictValues());
  appendLabels(dir, sampleLabels());
  return fs.readFileSync(path.join(dir, 'labels.plp'));
}

function decodeAll(chunkSize) {
  const buf = buildPack();
  return collect(decodeBuffer(buf, chunkSize));
}

test('byte-by-byte feed decodes identically to one-shot feed', () => {
  const oneShot = decodeAll(undefined);
  const bytewise = decodeAll(1);
  assert.deepStrictEqual(bytewise.errors, []);
  assert.deepStrictEqual(bytewise.labels, oneShot.labels);
  const ws = bytewise.labels.map((l) => l.workstation);
  assert.ok(ws.every((w) => w === WS_MULTIBYTE));
});

test('splitting the stream inside a multi-byte character restores it fully', () => {
  const buf = buildPack();
  const needle = Buffer.from(WS_MULTIBYTE, 'utf8');
  const at = buf.indexOf(needle);
  assert.ok(at > 0, 'multibyte string present in file');

  // Cut in the middle of every multi-byte character of the string.
  const cuts = new Set();
  for (let i = 1; i < needle.length; i++) {
    if ((needle[i] & 0xc0) === 0x80) cuts.add(at + i); // continuation byte boundary
  }
  assert.ok(cuts.size >= 8, 'string has several multi-byte characters');

  const reference = collect(decodeBuffer(buf));
  for (const cut of cuts) {
    const decoder = new IncrementalDecoder();
    const events = [...decoder.push(buf.subarray(0, cut)), ...decoder.push(buf.subarray(cut)), ...decoder.end()];
    const result = collect(events);
    assert.deepStrictEqual(result.errors, [], `cut at ${cut}`);
    assert.deepStrictEqual(result.labels, reference.labels, `cut at ${cut}`);
  }
});

test('every possible two-chunk split around the multibyte region is lossless', () => {
  const buf = buildPack();
  const needle = Buffer.from(WS_MULTIBYTE, 'utf8');
  const at = buf.indexOf(needle);
  const reference = collect(decodeBuffer(buf));
  for (let cut = at - 2; cut <= at + needle.length + 2; cut++) {
    const decoder = new IncrementalDecoder();
    const events = [...decoder.push(buf.subarray(0, cut)), ...decoder.push(buf.subarray(cut)), ...decoder.end()];
    const result = collect(events);
    assert.deepStrictEqual(result.errors, [], `cut at ${cut}`);
    assert.deepStrictEqual(result.labels, reference.labels, `cut at ${cut}`);
  }
});

test('random small chunk sizes never produce mojibake or dropped chars', () => {
  const buf = buildPack();
  const reference = collect(decodeBuffer(buf));
  for (const size of [2, 3, 5, 7, 13]) {
    const result = collect(decodeBuffer(buf, size));
    assert.deepStrictEqual(result.errors, [], `chunk size ${size}`);
    assert.deepStrictEqual(result.labels, reference.labels, `chunk size ${size}`);
  }
});
