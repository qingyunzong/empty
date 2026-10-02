import { test } from 'node:test';
import assert from 'node:assert/strict';
import { genesis, applyRepair, mergeVersions } from '../src/version.js';
import { explain } from '../src/explain.js';
import { HISTORY_CONFLICT } from '../src/errors.js';

const domains = { x: [0, 10], y: [0, 10], z: [0, 10] };

function base() {
  return genesis({ x: 1, y: 2, z: 3 }, domains);
}

test('concurrent repairs merge commutatively', () => {
  const b = base();
  const va = applyRepair(b, { x: 5 }, 4, 'nodeA');
  const vb = applyRepair(b, { y: 9 }, 7, 'nodeB');
  const m1 = mergeVersions(va, vb);
  const m2 = mergeVersions(vb, va);
  assert.deepEqual(m1, m2, 'merge must be commutative');
  assert.deepEqual(m1.data, { x: 5, y: 9, z: 3 });
  assert.deepEqual(m1.vector, { nodeA: 1, nodeB: 1 });
});

test('conflicting concurrent repairs resolve deterministically and commute', () => {
  const b = base();
  const va = applyRepair(b, { x: 5 }, 4, 'nodeA');
  const vc = applyRepair(b, { x: 8 }, 7, 'nodeC');
  const m1 = mergeVersions(va, vc);
  const m2 = mergeVersions(vc, va);
  assert.deepEqual(m1, m2);
  // Winner is the version with the lexicographically larger id.
  const winner = (va.id > vc.id) ? 5 : 8;
  assert.equal(m1.data.x, winner);
});

test('merge of causally ordered versions picks the later one', () => {
  const b = base();
  const v1 = applyRepair(b, { x: 5 }, 4, 'nodeA');
  const v2 = applyRepair(v1, { y: 7 }, 5, 'nodeA');
  assert.equal(mergeVersions(v1, v2), v2);
  assert.equal(mergeVersions(v2, v1), v2);
  assert.equal(mergeVersions(v2, v2), v2);
});

test('same vector clock with divergent data raises HISTORY_CONFLICT', () => {
  const b = base();
  const v1 = applyRepair(b, { x: 5 }, 4, 'nodeA');
  const forged = { ...v1, data: { ...v1.data, x: 6 } };
  assert.throws(() => mergeVersions(v1, forged), (e) => e.code === HISTORY_CONFLICT);
});

test('explain replays a merged history and verifies provenance', () => {
  const b = base();
  const va = applyRepair(b, { x: 5 }, 4, 'nodeA');
  const vb = applyRepair(b, { y: 9 }, 7, 'nodeB');
  const vc = applyRepair(va, { z: 0 }, 3, 'nodeC');
  const merged = mergeVersions(vc, vb);
  const trace = explain(merged);
  assert.equal(trace.ok, true);
  assert.equal(trace.verified, true);
  assert.deepEqual(trace.replayed.data, merged.data);
  assert.deepEqual(trace.replayed.vector, merged.vector);
  // genesis + 3 repairs + 1 merge
  assert.equal(trace.steps.length, 5);
  assert.equal(trace.steps[0].type, 'genesis');
  assert.equal(trace.steps.at(-1).type, 'merge');
});

test('explain detects tampered data as HISTORY_CONFLICT', () => {
  const b = base();
  const va = applyRepair(b, { x: 5 }, 4, 'nodeA');
  const tampered = { ...va, data: { ...va.data, x: 999 } };
  assert.throws(() => explain(tampered), (e) => e.code === HISTORY_CONFLICT);
});

test('explain detects a forged repair event as HISTORY_CONFLICT', () => {
  const b = base();
  const va = applyRepair(b, { x: 5 }, 4, 'nodeA');
  const history = va.history.map((e) =>
    e.type === 'repair' ? { ...e, diff: { x: 7 } } : e);
  const forged = { ...va, history };
  assert.throws(() => explain(forged), (e) => e.code === HISTORY_CONFLICT);
});
