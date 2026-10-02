import test from 'node:test';
import assert from 'node:assert/strict';
import { ReleaseEngine } from '../src/engine.js';

function releasedEngine() {
  const e = new ReleaseEngine();
  e.process({ kind: 'cip', eventTs: 0, line: 'L1', start: -60_000, end: 0, ok: true, op: 'c1' });
  e.process({ kind: 'fill', eventTs: 10_000, batch: 'b1', vol: 500, weight: 505, op: 'f1' });
  e.process({ kind: 'lab', eventTs: 20_000, batch: 'b1', pass: true, op: 'l1' });
  return e;
}

test('acceptance 1: lab retract rolls RELEASE back to HOLD with compensation', () => {
  const e = releasedEngine();
  assert.equal(e.batches.get('b1').status, 'RELEASE');

  e.process({ kind: 'retract', eventTs: 30_000, target: 'lab', id: 'l1' });

  const b = e.batches.get('b1');
  assert.equal(b.status, 'HOLD');
  assert.equal(b.reason, 'LAB_PENDING');

  assert.equal(e.comps.length, 1);
  assert.equal(e.comps[0].action, 'COMPENSATE_RELEASE');
  assert.equal(e.comps[0].batch, 'b1');

  const tr = e.transitions.filter((t) => t.batch === 'b1');
  assert.deepEqual(
    tr.map((t) => [t.from, t.to, t.version]),
    [['HOLD', 'RELEASE', 1], ['RELEASE', 'HOLD', 2]],
  );
  assert.equal(e.comps[0].seq, tr[1].seq); // compensation tied to the transition
});

test('retracted lab can be replaced by a new lab result', () => {
  const e = releasedEngine();
  e.process({ kind: 'retract', eventTs: 30_000, target: 'lab', id: 'l1' });
  e.process({ kind: 'lab', eventTs: 40_000, batch: 'b1', pass: true, op: 'l2' });
  assert.equal(e.batches.get('b1').status, 'RELEASE');
  assert.equal(e.batches.get('b1').version, 3);
});

test('missing lab pins batch to HOLD; lab fail stays HOLD', () => {
  const e = new ReleaseEngine();
  e.process({ kind: 'cip', eventTs: 0, line: 'L1', start: -60_000, end: 0, ok: true, op: 'c1' });
  e.process({ kind: 'fill', eventTs: 10_000, batch: 'b1', vol: 500, weight: 505, op: 'f1' });
  assert.equal(e.batches.get('b1').status, 'HOLD');
  assert.equal(e.batches.get('b1').reason, 'LAB_PENDING');

  e.process({ kind: 'lab', eventTs: 20_000, batch: 'b1', pass: false, op: 'l1' });
  assert.equal(e.batches.get('b1').status, 'HOLD');
  assert.equal(e.batches.get('b1').reason, 'LAB_FAIL');
});

test('late lab (older than watermark) is logged but still flips HOLD to RELEASE', () => {
  const e = new ReleaseEngine();
  e.process({ kind: 'cip', eventTs: 0, line: 'L1', start: -60_000, end: 0, ok: true, op: 'c1' });
  e.process({ kind: 'fill', eventTs: 10_000, batch: 'b1', vol: 500, weight: 505, op: 'f1' });
  // Unrelated event far in the future pushes the watermark past the lab's ts.
  e.process({ kind: 'fill', eventTs: 10_000_000, batch: 'b2', vol: 100, weight: 100, op: 'f2' });
  e.process({ kind: 'lab', eventTs: 20_000, batch: 'b1', pass: true, op: 'l1' });

  assert.equal(e.lates.length, 1);
  assert.equal(e.lates[0].ref, 'l1');
  assert.equal(e.lates[0].watermark, 10_000_000 - 180_000);
  assert.equal(e.batches.get('b1').status, 'RELEASE');
});
