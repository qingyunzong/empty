import test from 'node:test';
import assert from 'node:assert/strict';
import { ReleaseEngine } from '../src/engine.js';

function withCip(e) {
  e.process({ kind: 'cip', eventTs: 0, line: 'L1', start: -60_000, end: 0, ok: true, op: 'c1' });
  return e;
}

test('acceptance 4: weight/volume contradiction goes to REJECT and lab cannot flip it', () => {
  const e = withCip(new ReleaseEngine());
  e.process({ kind: 'fill', eventTs: 10_000, batch: 'b1', vol: 100, weight: 200, op: 'f1' }); // density 2.0
  const b = e.batches.get('b1');
  assert.equal(b.status, 'REJECT');
  assert.equal(b.reason, 'DENSITY_MISMATCH');

  e.process({ kind: 'lab', eventTs: 20_000, batch: 'b1', pass: true, op: 'l1' });
  assert.equal(b.status, 'REJECT'); // lab pass must not flip REJECT

  const tr = e.transitions.filter((t) => t.batch === 'b1');
  assert.deepEqual(tr.map((t) => [t.from, t.to]), [['HOLD', 'REJECT']]);
});

test('REJECT is absorbing: retracting the bad fill does not resurrect the batch', () => {
  const e = withCip(new ReleaseEngine());
  e.process({ kind: 'fill', eventTs: 10_000, batch: 'b1', vol: 100, weight: 200, op: 'f1' });
  e.process({ kind: 'retract', eventTs: 15_000, target: 'fill', id: 'f1' });
  assert.equal(e.batches.get('b1').status, 'REJECT');
});

test('density bounds are inclusive at 0.95 and 1.05', () => {
  const e = withCip(new ReleaseEngine());
  e.process({ kind: 'fill', eventTs: 10_000, batch: 'lo', vol: 200, weight: 190, op: 'f1' });
  e.process({ kind: 'fill', eventTs: 11_000, batch: 'hi', vol: 200, weight: 210, op: 'f2' });
  e.process({ kind: 'fill', eventTs: 12_000, batch: 'under', vol: 200, weight: 189.9, op: 'f3' });
  e.process({ kind: 'lab', eventTs: 13_000, batch: 'lo', pass: true, op: 'l1' });
  e.process({ kind: 'lab', eventTs: 14_000, batch: 'hi', pass: true, op: 'l2' });
  e.process({ kind: 'lab', eventTs: 15_000, batch: 'under', pass: true, op: 'l3' });
  assert.equal(e.batches.get('lo').status, 'RELEASE');
  assert.equal(e.batches.get('hi').status, 'RELEASE');
  assert.equal(e.batches.get('under').status, 'REJECT');
});

test('vol <= 0 reports VOL_INVALID and rejects the batch', () => {
  const e = withCip(new ReleaseEngine());
  e.process({ kind: 'fill', eventTs: 10_000, batch: 'b1', vol: 0, weight: 100, op: 'f1' });
  e.process({ kind: 'fill', eventTs: 11_000, batch: 'b2', vol: -5, weight: 100, op: 'f2' });
  e.process({ kind: 'lab', eventTs: 12_000, batch: 'b1', pass: true, op: 'l1' });

  const volErrors = e.errors.filter((x) => x.code === 'VOL_INVALID');
  assert.equal(volErrors.length, 2);
  assert.deepEqual(volErrors.map((x) => x.op), ['f1', 'f2']);
  assert.equal(e.batches.get('b1').status, 'REJECT');
  assert.equal(e.batches.get('b1').reason, 'VOL_INVALID');
  assert.equal(e.batches.get('b2').status, 'REJECT');
});
