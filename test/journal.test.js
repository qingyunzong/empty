'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readJournal, appendLayer, rewriteJournal } = require('../src/journal');
const { TraceabilitySystem } = require('../src/system');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trace-journal-'));

const R1 = { batch: 'a', defects: ['d0'] };
const R2 = { batch: 'b', op: 'split', parents: ['a'] };
const R3 = { batch: 'c', op: 'test', parents: ['b'], defects: ['d1'] };

// Acceptance 3 (journal level): a kill mid-layer leaves a torn tail; recovery
// replays complete layers only.
test('crash mid-layer recovers to the last complete layer', () => {
  const dir = tmpdir();
  const jf = path.join(dir, 'journal.jsonl');
  appendLayer(jf, 1, [R1, R2]);
  // Simulate a kill after the layer-2 begin and one record (each fsync'd).
  fs.appendFileSync(jf, JSON.stringify({ type: 'begin', layer: 2, count: 2 }) + '\n');
  fs.appendFileSync(jf, JSON.stringify({ type: 'record', layer: 2, data: R3 }) + '\n');
  const { layers, recoveredTo } = readJournal(jf);
  assert.equal(recoveredTo, 1);
  assert.deepEqual(layers, [[R1, R2]]);
});

test('crash before the commit record discards the whole layer', () => {
  const dir = tmpdir();
  const jf = path.join(dir, 'journal.jsonl');
  appendLayer(jf, 1, [R1]);
  fs.appendFileSync(jf, JSON.stringify({ type: 'begin', layer: 2, count: 1 }) + '\n');
  fs.appendFileSync(jf, JSON.stringify({ type: 'record', layer: 2, data: R2 }) + '\n');
  // killed before commit
  assert.equal(readJournal(jf).recoveredTo, 1);
});

test('torn JSON line is treated as a crash tail', () => {
  const dir = tmpdir();
  const jf = path.join(dir, 'journal.jsonl');
  appendLayer(jf, 1, [R1]);
  fs.appendFileSync(jf, '{"type":"begin","layer":2,"coun');
  assert.equal(readJournal(jf).recoveredTo, 1);
});

test('layer number hole is rejected', () => {
  const dir = tmpdir();
  const jf = path.join(dir, 'journal.jsonl');
  appendLayer(jf, 1, [R1]);
  appendLayer(jf, 3, [R2]); // layer 2 missing
  assert.throws(() => readJournal(jf), (e) => e.kind === 'LAYER_HOLE');
});

test('system recovery rebuilds state equal to the last complete layer', () => {
  const dir = tmpdir();
  const sys = new TraceabilitySystem(dir);
  sys.recover();
  sys.importFile0 = null;
  // import two layers through the public API
  const f1 = path.join(dir, 'l1.jsonl');
  const f2 = path.join(dir, 'l2.jsonl');
  fs.writeFileSync(f1, JSON.stringify(R1) + '\n' + JSON.stringify(R2) + '\n');
  fs.writeFileSync(f2, JSON.stringify(R3) + '\n');
  sys.importFile(f1);
  sys.importFile(f2);
  assert.equal(sys.recoveredTo, 2);
  // simulate a kill during layer 3
  fs.appendFileSync(sys.journalFile, JSON.stringify({ type: 'begin', layer: 3, count: 1 }) + '\n');
  const fresh = new TraceabilitySystem(dir);
  const { recoveredTo } = fresh.recover();
  assert.equal(recoveredTo, 2);
  assert.ok(fresh.graph.has('c'), 'layer-2 batch survives');
  assert.deepEqual(fresh.stats(), sys.stats());
});

test('rollback truncates to the requested layer', () => {
  const dir = tmpdir();
  const jf = path.join(dir, 'journal.jsonl');
  appendLayer(jf, 1, [R1]);
  appendLayer(jf, 2, [R2]);
  appendLayer(jf, 3, [R3]);
  rewriteJournal(jf, readJournal(jf).layers.slice(0, 1));
  const { layers, recoveredTo } = readJournal(jf);
  assert.equal(recoveredTo, 1);
  assert.deepEqual(layers, [[R1]]);
});

test('rollback beyond the last layer is rejected', () => {
  const dir = tmpdir();
  const sys = new TraceabilitySystem(dir);
  sys.recover();
  assert.throws(() => sys.rollback(1), (e) => e.kind === 'BAD_LAYER');
});
