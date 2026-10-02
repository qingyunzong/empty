import test from 'node:test';
import assert from 'node:assert/strict';
import { ReleaseEngine } from '../src/engine.js';

// c1 ok [0,100]; c2 ok [200,250]; c3 FAILED [280,330].
// f1@150 sits in window c1->c2; f2@300 sits after c2 but c3 starts at 280.
function build() {
  const e = new ReleaseEngine();
  e.process({ kind: 'cip', eventTs: 100, line: 'L1', start: 0, end: 100, ok: true, op: 'c1' });
  e.process({ kind: 'cip', eventTs: 250, line: 'L1', start: 200, end: 250, ok: true, op: 'c2' });
  e.process({ kind: 'cip', eventTs: 330, line: 'L1', start: 280, end: 330, ok: false, op: 'c3' });
  e.process({ kind: 'fill', eventTs: 150, batch: 'b1', vol: 100, weight: 100, op: 'f1' });
  e.process({ kind: 'fill', eventTs: 300, batch: 'b1', vol: 100, weight: 100, op: 'f2' });
  e.process({ kind: 'lab', eventTs: 400, batch: 'b1', pass: true, op: 'l1' });
  return e;
}

test('acceptance 2: pending CIP window is HOLD, not REJECT (pending != unsatisfiable)', () => {
  const e = build();
  const b = e.batches.get('b1');
  assert.equal(b.status, 'HOLD'); // f2 falls after failed cip c3 starts
  assert.equal(b.reason, 'CIP_WINDOW_PENDING');
  assert.equal(e.transitions.every((t) => t.to !== 'REJECT'), true);
});

test('acceptance 2: cip retract re-attributes fills across the cleaning boundary', () => {
  const e = build();
  assert.equal(e.batches.get('b1').status, 'HOLD');

  // Retracting the failed cip c3 moves f2 back into the post-c2 window.
  e.process({ kind: 'retract', eventTs: 500, target: 'cip', id: 'c3' });
  const b = e.batches.get('b1');
  assert.equal(b.status, 'RELEASE');
  const tr = e.transitions.at(-1);
  assert.deepEqual([tr.from, tr.to, tr.reason], ['HOLD', 'RELEASE', 'OK']);
});

test('acceptance 2: retracting the anchoring ok cip rolls RELEASE back with compensation', () => {
  const e = new ReleaseEngine();
  e.process({ kind: 'cip', eventTs: 100, line: 'L1', start: 0, end: 100, ok: true, op: 'c1' });
  e.process({ kind: 'fill', eventTs: 150, batch: 'b1', vol: 100, weight: 100, op: 'f1' });
  e.process({ kind: 'lab', eventTs: 200, batch: 'b1', pass: true, op: 'l1' });
  assert.equal(e.batches.get('b1').status, 'RELEASE');

  e.process({ kind: 'retract', eventTs: 300, target: 'cip', id: 'c1' });
  const b = e.batches.get('b1');
  assert.equal(b.status, 'HOLD');
  assert.equal(b.reason, 'CIP_WINDOW_PENDING');
  assert.equal(e.comps.length, 1);
  assert.equal(e.comps[0].reason, 'CIP_WINDOW_PENDING');
});

test('late-arriving cip can fix a pending window', () => {
  const e = new ReleaseEngine();
  e.process({ kind: 'fill', eventTs: 150, batch: 'b1', vol: 100, weight: 100, op: 'f1' });
  assert.equal(e.batches.get('b1').reason, 'CIP_WINDOW_PENDING');
  e.process({ kind: 'cip', eventTs: 100, line: 'L1', start: 0, end: 100, ok: true, op: 'c1' });
  e.process({ kind: 'lab', eventTs: 200, batch: 'b1', pass: true, op: 'l1' });
  assert.equal(e.batches.get('b1').status, 'RELEASE');
});
