import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodePackage, readIndex, readAllRecords } from '../src/package.js';
import { Decoder } from '../src/decoder.js';
import { DEMO_PROGRAM, DEMO_TRACE } from '../support/helpers.mjs';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cnc-exec-'));
}

test('execution matches hand-enumerated trace', () => {
  const dir = tmpdir();
  const base = path.join(dir, 'demo');
  const index = encodePackage(DEMO_PROGRAM, base, { blockLines: 3 });
  assert.equal(index.blockCount, 5);
  const dec = new Decoder({ totalBlocks: index.blockCount });
  for (const rec of readAllRecords(base, readIndex(base))) dec.ingest(rec);
  const res = dec.run();
  assert.equal(res.done, true);
  assert.deepEqual(dec.events, DEMO_TRACE);
});

test('stall on missing blocks then resume in-process gives same trace', () => {
  const dir = tmpdir();
  const base = path.join(dir, 'demo');
  const index = encodePackage(DEMO_PROGRAM, base, { blockLines: 3 });
  const records = readAllRecords(base, readIndex(base));
  const dec = new Decoder({ totalBlocks: index.blockCount });
  for (const rec of records.slice(0, 3)) dec.ingest(rec);
  const first = dec.run();
  assert.equal(first.stalled, true);
  assert.equal(dec.ack, 3);
  for (const rec of records.slice(3)) dec.ingest(rec);
  const second = dec.run();
  assert.equal(second.done, true);
  assert.deepEqual(dec.events, DEMO_TRACE);
});
