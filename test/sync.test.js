'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Planner } = require('../src/planner');
const { syncPeers } = require('../src/sync');
const { tmpdir } = require('./helpers');

function terminal(termId, setupFn) {
  const dir = tmpdir();
  const p = Planner.open(dir, { termId });
  p.op('shift', { id: 'S1', capacity: 100 });
  p.op('shift', { id: 'S2', capacity: 100 });
  p.op('mold', { id: 'M1', life: 1000 });
  p.op('setup', { mold: 'M1', minutes: 10 });
  if (setupFn) setupFn(p);
  p.apply();
  return dir;
}

test('bidirectional delta exchange: version vectors merge, plans converge', () => {
  const dirA = terminal('A', (p) => {
    p.op('insert', { job: 'J1', mold: 'M1', shots: 10, duration: 40 });
  });
  const dirB = terminal('B', (p) => {
    p.op('insert', { job: 'J2', mold: 'M1', shots: 10, duration: 40 });
  });
  const out = syncPeers(dirA, dirB);
  assert.equal(out.a.imported, 5); // B's 4 setup ops + insert J2
  assert.equal(out.b.imported, 5);
  assert.deepEqual(out.a.vv, { A: 5, B: 5 });
  assert.deepEqual(out.b.vv, { A: 5, B: 5 });
  assert.equal(out.a.result.feasible, true);
  assert.equal(out.b.result.feasible, true);
  assert.equal(out.a.result.planStr, out.b.result.planStr, 'both terminals converge');

  // Idempotent: a second sync exchanges nothing.
  const again = syncPeers(dirA, dirB);
  assert.equal(again.a.imported, 0);
  assert.equal(again.b.imported, 0);
});

test('resource over-allocation after merge becomes pending, not infeasible', () => {
  // Each terminal pins a 80-minute job into the same 100-minute shift.
  const dirA = terminal('A', (p) => {
    p.op('insert', { job: 'J1', mold: 'M1', shots: 10, duration: 80 });
    p.op('assign', { job: 'J1', shift: 'S1' });
  });
  const dirB = terminal('B', (p) => {
    p.op('insert', { job: 'J2', mold: 'M1', shots: 10, duration: 80 });
    p.op('assign', { job: 'J2', shift: 'S1' });
  });
  const out = syncPeers(dirA, dirB);
  for (const side of ['a', 'b']) {
    const r = out[side].result;
    assert.equal(r.feasible, true, `${side} stays feasible`);
    assert.deepEqual(r.pending, ['J1'], 'lower-stamped pin demoted to pending');
    assert.ok(r.planStr.includes('J2'), 'winner stays planned');
  }
  assert.equal(out.a.result.planStr, out.b.result.planStr);
});

test('concurrent conflicting assigns resolve by version vector tie-break', () => {
  const dirA = terminal('A', (p) => {
    p.op('insert', { job: 'J1', mold: 'M1', shots: 10, duration: 40 });
  });
  const dirB = terminal('B');
  syncPeers(dirA, dirB); // both know J1 now

  // Concurrent conflicting pins: A -> S1, B -> S2.
  const a = Planner.open(dirA);
  a.op('assign', { job: 'J1', shift: 'S1' });
  a.apply();
  const b = Planner.open(dirB);
  b.op('assign', { job: 'J1', shift: 'S2' });
  b.apply();

  const out = syncPeers(dirA, dirB);
  // Concurrent ops (neither vv dominates): tie-break by (counter, term).
  // A's assign has counter 6 > B's 5, so A's pin to S1 wins on both terminals.
  assert.equal(out.a.result.planStr, out.b.result.planStr);
  const pa = Planner.open(dirA);
  const pb = Planner.open(dirB);
  assert.equal(pa.state.pinned.J1, 'S1');
  assert.equal(pb.state.pinned.J1, 'S1');
  assert.equal(pa.plan().planStr, pb.plan().planStr);
});
