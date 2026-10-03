import test from 'node:test';
import assert from 'node:assert/strict';
import { tick, compare, mergeClocks } from '../src/clock.js';
import { makeEntry, logHash } from '../src/log.js';
import { fold, resolveConflict } from '../src/fold.js';
import { initialDyn, computeTimes } from '../src/model.js';
import { masterPlan } from './helpers.js';

test('vector clock comparison and merge', () => {
  assert.equal(compare({ A: 1 }, { A: 1, B: 1 }), -1);
  assert.equal(compare({ A: 2, B: 1 }, { A: 1, B: 1 }), 1);
  assert.equal(compare({ A: 1 }, { B: 1 }), 'concurrent');
  assert.equal(compare({ A: 1 }, { A: 1 }), 0);
  assert.deepEqual(mergeClocks({ A: 2 }, { A: 1, B: 3 }), { A: 2, B: 3 });
  assert.deepEqual(tick({ A: 2 }, 'A'), { A: 3 });
});

test('fold applies insert/move/cancel deterministically regardless of input order', () => {
  const plan = masterPlan();
  const e1 = makeEntry('A', tick({}, 'A'), { type: 'move', op: 'J2.o1', machine: 'M2', index: 0 }, null);
  const e2 = makeEntry('B', tick({}, 'B'), { type: 'cancel', op: 'J1.o3' }, null);
  const e3 = makeEntry('B', tick({ B: 1 }, 'B'), { type: 'insert', op: { id: 'J2.o3', job: 'J2', cap: 'paint', dur: 2 }, machine: 'M2', index: 2 }, e2.hash);
  const r1 = fold(plan, [e1, e2, e3]);
  const r2 = fold(plan, [e3, e1, e2]);
  assert.deepEqual(r1, r2, 'fold must be order-independent');
  assert.equal(r1.pending.length, 0);
  assert.deepEqual(r1.dyn.order.M2, ['J2.o1', 'J2.o2', 'J2.o3']);
  assert.deepEqual(r1.dyn.cancelled, ['J1.o3']);
  const times = computeTimes(plan, r1.dyn);
  assert.ok(times.cost <= plan.budget);
});

test('conflict resolution is deterministic and total', () => {
  const a1 = makeEntry('A', tick({}, 'A'), { type: 'move', op: 'X', machine: 'M1', index: 0 }, null);
  const b1 = makeEntry('B', tick({}, 'B'), { type: 'move', op: 'X', machine: 'M2', index: 0 }, null);
  assert.equal(resolveConflict(a1, b1), b1);
  assert.equal(resolveConflict(b1, a1), b1, 'symmetric inputs, same winner');
  const cancel = makeEntry('A', tick({}, 'A'), { type: 'cancel', op: 'X' }, null);
  assert.equal(resolveConflict(cancel, b1), cancel, 'cancel beats move');
});

test('log hash is content-addressed and stable', () => {
  const e = makeEntry('A', tick({}, 'A'), { type: 'cancel', op: 'J1.o1' }, null);
  assert.equal(logHash([e]), logHash([e]));
  assert.notEqual(logHash([e]), logHash([]));
});
