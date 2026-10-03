// Acceptance 1: crash once before the rename and once after it; recovery must
// produce output byte-identical to a clean no-fault run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir, writeInput, runCli, readOut, vision, barcode, audit, retract } from '../test-support/helpers.js';

const events = [
  barcode(1000, 'f1', 'c1'),
  vision(1100, 'f1', 'skuA', 'scratch'),
  barcode(1200, 'f2', 'c1'),
  barcode(1300, 'f3', 'c2'),
  vision(1400, 'f3', 'skuB', 'dent'),
  retract(1500, 'vision', 'f3'),
  audit(1600, 'skuA', true),
  audit(1700, 'skuB', true),
  barcode(1800, 'f4', 'c2'),
];

test('crash before and after rename both recover to the no-fault result', () => {
  const inDir = writeInput(events);

  const cleanDir = tmpdir();
  const clean = runCli(inDir, cleanDir);
  assert.equal(clean.status, 0, clean.stderr);
  const expected = readOut(cleanDir);

  // Crash after outbox.tmp is written, before materialization ("rename").
  const crashBeforeDir = tmpdir();
  const crash1 = runCli(inDir, crashBeforeDir, { PACK_CRASH_AT: 'before-rename' });
  assert.equal(crash1.status, 42);
  assert.ok(fs.existsSync(path.join(crashBeforeDir, 'outbox.tmp')), 'half outbox remains');
  assert.ok(!fs.existsSync(path.join(crashBeforeDir, 'cases.jsonl')), 'no final output yet');
  assert.ok(fs.existsSync(path.join(crashBeforeDir, 'wal.jsonl')), 'wal survives');

  // Recovery: discard half outbox, replay wal, regenerate.
  const recover1 = runCli(inDir, crashBeforeDir);
  assert.equal(recover1.status, 0, recover1.stderr);
  assert.ok(!fs.existsSync(path.join(crashBeforeDir, 'outbox.tmp')), 'half outbox discarded');
  assert.deepEqual(readOut(crashBeforeDir), expected);

  // Crash just after materialization.
  const crashAfterDir = tmpdir();
  const crash2 = runCli(inDir, crashAfterDir, { PACK_CRASH_AT: 'after-rename' });
  assert.equal(crash2.status, 42);
  assert.ok(fs.existsSync(path.join(crashAfterDir, 'cases.jsonl')));

  const recover2 = runCli(inDir, crashAfterDir);
  assert.equal(recover2.status, 0, recover2.stderr);
  assert.deepEqual(readOut(crashAfterDir), expected);
});
