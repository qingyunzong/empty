import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TraceabilitySystem } from '../src/system.js';
import { appendRecord } from '../src/journal.js';
import { LayerHoleError } from '../src/errors.js';

function tmpJournal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-journal-'));
  return path.join(dir, 'journal.jsonl');
}

const L1 = [
  { batch: 'raw', defects: ['d0'], on: { merge: 'blend' } },
  { batch: 'blend', parents: ['raw'], defects: [], on: { test: 'blend' } },
];
const L2 = [
  { batch: 'pack', parents: ['blend'], defects: ['d9'], on: { ship: 'pack' } },
];
const L3 = [
  { batch: 'rework', parents: ['pack'], defects: [], pending: true },
];

// Acceptance 3: kill mid-layer, restart recovers to the last complete layer.
test('crash mid-layer recovers to the last committed layer', () => {
  const journal = tmpJournal();
  const sys = new TraceabilitySystem(journal);
  sys.importRecords(L1, 1);
  const afterL2 = sys.importRecords(L2, 2);
  assert.equal(afterL2.recoveredTo, 2);
  const stateAtL2 = JSON.stringify(sys.batches);
  const minAtL2 = sys.minStates();

  // Simulate a kill in the middle of layer 3: begin + one fsync'd record,
  // no commit, plus a torn partial line from the crashed writer.
  appendRecord(journal, { type: 'begin', layer: 3 });
  appendRecord(journal, { type: 'batch', layer: 3, record: L3[0] });
  fs.appendFileSync(journal, '{"type":"batch","layer":3,"rec');

  const restarted = new TraceabilitySystem(journal);
  // The constructor already recovered (and truncated the torn tail).
  assert.equal(restarted.recoveredTo, 2);
  assert.equal(restarted.discardedTail, true);
  assert.equal(JSON.stringify(restarted.batches), stateAtL2);
  assert.equal(restarted.minStates(), minAtL2);

  // The journal is still usable: the next import becomes layer 3.
  const afterL3 = restarted.importRecords(L3);
  assert.equal(afterL3.layer, 3);
  assert.equal(afterL3.recoveredTo, 3);
});

test('rollback drops layers back to the savepoint', () => {
  const journal = tmpJournal();
  const sys = new TraceabilitySystem(journal);
  sys.importRecords(L1);
  sys.importRecords(L2);
  sys.importRecords(L3);
  assert.equal(sys.recoveredTo, 3);

  const back = sys.rollback(2);
  assert.equal(back.recoveredTo, 1);
  assert.deepEqual(sys.batches, L1);

  // State survives a restart: the journal itself was truncated.
  const restarted = new TraceabilitySystem(journal);
  assert.equal(restarted.recoveredTo, 1);
  assert.deepEqual(restarted.batches, L1);

  const toZero = restarted.rollback(1);
  assert.equal(toZero.recoveredTo, 0);
  assert.equal(restarted.minStates(), 0);
});

test('layer holes are rejected', () => {
  const journal = tmpJournal();
  const sys = new TraceabilitySystem(journal);
  sys.importRecords(L1, 1);
  assert.throws(() => sys.importRecords(L2, 3), LayerHoleError);
  assert.throws(() => sys.rollback(2), LayerHoleError);
  assert.throws(() => sys.rollback(0), LayerHoleError);
});
