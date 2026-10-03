import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/graph.js';
import { EXIT } from '../src/errors.js';

let seq = 0;
function entry(op, inputs, outputs, ts) {
  seq++;
  return { site: 'T', seq, ts, op, in: inputs, out: outputs, id: `e${seq}` };
}
const lm = (lot, mass) => ({ lot, mass });

function base() {
  const g = new Graph();
  g.apply(entry('register', [], [lm('A', 100)], 1));
  g.apply(entry('register', [], [lm('B', 50)], 2));
  return g;
}

test('merge within tolerance applies', () => {
  const g = base();
  assert.equal(g.apply(entry('merge', [lm('A', 100), lm('B', 50)], [lm('C', 150.5)], 3)), 'applied');
  assert.equal(g.lots.get('A').status, 'consumed');
  assert.equal(g.lots.get('C').status, 'open');
});

test('merge conservation out of bounds is rejected with code 2', () => {
  const g = base();
  assert.throws(
    () => g.apply(entry('merge', [lm('A', 100), lm('B', 50)], [lm('C', 200)], 3)),
    (e) => e.code === EXIT.VALIDATION && /not conserved/.test(e.message)
  );
});

test('split conservation out of bounds is rejected', () => {
  const g = base();
  assert.throws(
    () => g.apply(entry('split', [lm('A', 100)], [lm('S1', 60), lm('S2', 60)], 3)),
    (e) => e.code === EXIT.VALIDATION
  );
});

test('consuming a consumed lot is rejected (status check)', () => {
  const g = base();
  g.apply(entry('split', [lm('A', 100)], [lm('S1', 60), lm('S2', 40)], 3));
  assert.throws(
    () => g.apply(entry('relabel', [lm('A', 1)], [lm('Z', 1)], 4)),
    (e) => e.code === EXIT.VALIDATION && /not open/.test(e.message)
  );
});

test('over-consuming remaining mass is rejected', () => {
  const g = base();
  g.apply(entry('split', [lm('A', 60)], [lm('S1', 30), lm('S2', 30)], 3));
  assert.throws(
    () => g.apply(entry('relabel', [lm('A', 41)], [lm('Z', 41)], 4)),
    (e) => e.code === EXIT.VALIDATION && /insufficient/.test(e.message)
  );
});

test('op predating its inputs is rejected (time order)', () => {
  const g = base();
  assert.throws(
    () => g.apply(entry('merge', [lm('A', 100), lm('B', 50)], [lm('C', 150)], 1)),
    (e) => e.code === EXIT.VALIDATION && /precedes/.test(e.message)
  );
});

test('cyclic relabel is rejected with code 2', () => {
  const g = base();
  g.apply(entry('relabel', [lm('A', 100)], [lm('A2', 100)], 3));
  assert.throws(
    () => g.apply(entry('relabel', [lm('A2', 100)], [lm('A', 100)], 4)),
    (e) => e.code === EXIT.VALIDATION && /cycle/.test(e.message)
  );
});

test('self relabel is a cycle', () => {
  const g = base();
  assert.throws(
    () => g.apply(entry('relabel', [lm('A', 100)], [lm('A', 100)], 3)),
    (e) => e.code === EXIT.VALIDATION && /cycle/.test(e.message)
  );
});

test('unknown parent goes pending, then converges on backfill', () => {
  const g = new Graph();
  const m = entry('merge', [lm('P', 10), lm('Q', 10)], [lm('R', 20)], 5);
  assert.equal(g.apply(m), 'pending');
  assert.equal(g.pending.length, 1);
  g.apply(entry('register', [], [lm('P', 10)], 4));
  assert.equal(g.pending.length, 1); // Q still missing
  g.apply(entry('register', [], [lm('Q', 10)], 4));
  assert.equal(g.pending.length, 0); // converged, never failed
  assert.ok(g.lots.has('R'));
});

test('duplicate entry id is idempotent', () => {
  const g = base();
  const m = entry('merge', [lm('A', 100), lm('B', 50)], [lm('C', 150)], 3);
  assert.equal(g.apply(m), 'applied');
  assert.equal(g.apply(m), 'duplicate');
  assert.equal(g.edges.length, 2);
});
