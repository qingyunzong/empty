import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/compiler.js';
import { Engine } from '../src/engine.js';

const program = compile('mul amount price qty');

test('commits batches and reports batch metadata', () => {
  const records = Array.from({ length: 5 }, (_, i) => ({ price: i + 1, qty: 2 }));
  const phases = [];
  const engine = new Engine(program, { batchSize: 2 });
  const result = engine.run(records, { onState: (s) => phases.push(s.phase) });
  assert.equal(result.ok, true);
  assert.equal(result.records.length, 5);
  assert.deepEqual(result.records.map((r) => r.seq), [0, 1, 2, 3, 4]);
  assert.deepEqual(result.batches.map((b) => [b.startSeq, b.endSeq]), [[0, 1], [2, 3], [4, 4]]);
  assert.deepEqual(phases, ['checkpoint', 'committed', 'checkpoint', 'committed', 'checkpoint', 'committed']);
});

test('a failing record rolls back only its own batch', () => {
  const records = [
    { price: 1, qty: 1 },
    { price: 2, qty: 2 },
    { price: 3, qty: 3 },
    { price: 4 },
    { price: 5, qty: 5 },
  ];
  const engine = new Engine(program, { batchSize: 3 });
  const result = engine.run(records);
  assert.equal(result.ok, false);
  assert.equal(result.error.type, 'MissingField');
  assert.equal(result.error.seq, 3);
  assert.equal(result.committedBoundary, 3);
  assert.deepEqual(result.records.map((r) => r.seq), [0, 1, 2]);
  assert.equal(result.batches.length, 1);
});

test('resume from state continues after the committed boundary', () => {
  const records = Array.from({ length: 5 }, (_, i) => ({ price: i + 1, qty: 2 }));
  const full = new Engine(program, { batchSize: 2 }).run(records);

  let state = null;
  const crashing = new Engine(program, { batchSize: 2, crashAfter: 4 });
  assert.throws(
    () => crashing.run(records, { onState: (s) => { state = s; } }),
    /Simulated crash/,
  );
  assert.equal(state.committed, 2);

  const resumed = new Engine(program, { batchSize: 2 }).run(records, { state });
  assert.equal(resumed.ok, true);
  assert.deepEqual(resumed.records, full.records);
  assert.deepEqual(resumed.batches, full.batches);
});
