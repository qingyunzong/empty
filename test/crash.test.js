import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runPack } from '../src/pack.js';
import { CrashInjected } from '../src/errors.js';
import {
  HASH_A, HASH_B, HASH_C, readOutputs, tmpDir, writeInput,
} from './helpers.js';

// Mixed workload: releases, quarantine, conflict, retracts and a late event.
function makeInput(dir) {
  return writeInput(dir, {
    'barcode.jsonl': [
      { eventTs: 1000, frame: 1, case: 'C1', op: 'b1' },
      { eventTs: 1100, frame: 2, case: 'C1', op: 'b2' },
      { eventTs: 1200, frame: 3, case: 'C2', op: 'b3' },
      { eventTs: 1300, frame: 4, case: 'C3', op: 'b4' },
      { eventTs: 1400, frame: 5, case: 'C3', op: 'b5' },
    ],
    'vision.jsonl': [
      { eventTs: 2000, frame: 1, sku: 'S1', defect: null, hash: HASH_A, op: 'v1' },
      { eventTs: 2100, frame: 3, sku: 'S2', defect: 'dent', hash: HASH_B, op: 'v2' },
      { eventTs: 2200, frame: 4, sku: 'S3', defect: null, hash: HASH_A, op: 'v3' },
      { eventTs: 2300, frame: 5, sku: 'S4', defect: null, hash: HASH_A, op: 'v4' },
    ],
    'audit.jsonl': [
      { eventTs: 3000, sku: 'S1', pass: true, op: 'a1' },
      { eventTs: 3100, sku: 'S3', pass: true, op: 'a2' },
      { eventTs: 3200, sku: 'S4', pass: true, op: 'a3' },
    ],
    'zz_retract.jsonl': [
      { type: 'retract', eventTs: 4000, target: 'vision', id: 'v2' },
    ],
    'late.jsonl': [
      { type: 'vision', eventTs: 500, frame: 2, sku: 'S1', defect: 'scratch', hash: HASH_C, op: 'v9' },
    ],
  });
}

test('acceptance 1: crash before rename and after rename both recover to the clean result', () => {
  const root = tmpDir();
  const inDir = makeInput(path.join(root, 'in'));

  // Clean reference run.
  const cleanOut = path.join(root, 'out-clean');
  runPack(inDir, cleanOut);
  const clean = readOutputs(cleanOut);

  // Crash after outbox tmp is written, before the rename.
  const crashBeforeOut = path.join(root, 'out-crash-before');
  assert.throws(
    () => runPack(inDir, crashBeforeOut, { crashPoint: 'before-rename' }),
    (err) => err instanceof CrashInjected && err.point === 'before-rename',
  );
  assert.ok(fs.existsSync(path.join(crashBeforeOut, 'cases.jsonl.tmp')), 'half-written outbox tmp persists');
  assert.ok(!fs.existsSync(path.join(crashBeforeOut, 'cases.jsonl')), 'nothing renamed yet');
  assert.ok(fs.existsSync(path.join(crashBeforeOut, 'wal.jsonl')), 'wal survives the crash');

  // Recovery: stale tmp discarded, wal replayed, state equals the no-fault run.
  runPack(inDir, crashBeforeOut);
  assert.ok(!fs.existsSync(path.join(crashBeforeOut, 'cases.jsonl.tmp')), 'stale tmp discarded on recovery');
  assert.deepEqual(readOutputs(crashBeforeOut), clean);

  // Crash just after the rename: outputs are already final, recovery is a no-op.
  const crashAfterOut = path.join(root, 'out-crash-after');
  assert.throws(
    () => runPack(inDir, crashAfterOut, { crashPoint: 'after-rename' }),
    (err) => err instanceof CrashInjected && err.point === 'after-rename',
  );
  assert.deepEqual(readOutputs(crashAfterOut), clean);
  runPack(inDir, crashAfterOut);
  assert.deepEqual(readOutputs(crashAfterOut), clean);

  // The wal itself is identical across all three runs.
  const walClean = fs.readFileSync(path.join(cleanOut, 'wal.jsonl'), 'utf8');
  assert.equal(fs.readFileSync(path.join(crashBeforeOut, 'wal.jsonl'), 'utf8'), walClean);
  assert.equal(fs.readFileSync(path.join(crashAfterOut, 'wal.jsonl'), 'utf8'), walClean);
});
