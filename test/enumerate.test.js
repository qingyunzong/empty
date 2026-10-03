// Acceptance 4: enumerate every scheduling order for <= 6 tasks and compare
// the resulting final states.
//  A) n independent tasks (n = 1..6): all n! claim orders must yield the
//     identical final assignment.
//  B) a 5-event poset (chain + concurrent pair + resolver): every linear
//     extension must yield the identical final state.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';

function* permutations(items) {
  if (items.length <= 1) {
    yield items.slice();
    return;
  }
  for (let i = 0; i < items.length; i += 1) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const perm of permutations(rest)) yield [items[i], ...perm];
  }
}

function replay(events, agvs) {
  const engine = new Engine();
  for (const agv of agvs) engine.applyEvent({ type: 'join', agv, ts: 0 });
  for (const ev of events) engine.applyEvent(ev);
  return engine.summary();
}

function normalizedTasks(summary) {
  const out = {};
  for (const [id, t] of Object.entries(summary.tasks)) {
    out[id] = {
      status: t.status,
      holder: t.holder,
      epoch: t.epoch,
      leaseStatus: t.leaseStatus,
      frontier: t.frontier.map((c) => c.agv).sort(),
    };
  }
  return out;
}

test('acceptance 4a: all n! orders of n<=6 independent tasks give identical finals', () => {
  for (let n = 1; n <= 6; n += 1) {
    const agvs = Array.from({ length: n }, (_, i) => `AGV${i + 1}`);
    const claims = agvs.map((agv, i) => ({
      type: 'claim',
      task: `T${i + 1}`,
      agv,
      epoch: 1,
      ttl: 1000,
      ts: i + 1,
      clock: { [agv]: 1 },
    }));
    let reference = null;
    let count = 0;
    for (const perm of permutations(claims)) {
      count += 1;
      const summary = replay(perm, agvs);
      const finals = normalizedTasks(summary);
      for (let i = 0; i < n; i += 1) {
        assert.equal(finals[`T${i + 1}`].status, 'granted');
        assert.equal(finals[`T${i + 1}`].holder, agvs[i]);
      }
      if (!reference) reference = finals;
      else assert.deepEqual(finals, reference, `order ${count} of ${n}! diverged`);
    }
    assert.equal(count, [1, 1, 2, 6, 24, 120, 720][n]);
  }
});

test('acceptance 4b: every linear extension of a causal poset gives the same finals', () => {
  // T1: chain a1 -> a2 (a2 takes over after a1's lease expires).
  // T2: concurrent pair b1,b2 (pending) resolved by b3 which dominates both.
  const events = [
    { id: 'a1', ev: { type: 'claim', task: 'T1', agv: 'A', epoch: 1, ttl: 5, ts: 0, clock: { A: 1 } }, preds: [] },
    { id: 'a2', ev: { type: 'claim', task: 'T1', agv: 'B', epoch: 2, ttl: 5, ts: 10, clock: { A: 1, B: 1 } }, preds: ['a1'] },
    { id: 'b1', ev: { type: 'claim', task: 'T2', agv: 'C', epoch: 1, ttl: 100, ts: 1, clock: { C: 1 } }, preds: [] },
    { id: 'b2', ev: { type: 'claim', task: 'T2', agv: 'D', epoch: 1, ttl: 100, ts: 2, clock: { D: 1 } }, preds: [] },
    { id: 'b3', ev: { type: 'claim', task: 'T2', agv: 'E', epoch: 2, ttl: 100, ts: 5, clock: { C: 1, D: 1, E: 1 } }, preds: ['b1', 'b2'] },
  ];
  const byId = new Map(events.map((e) => [e.id, e]));

  function* linearExtensions(done, remaining) {
    if (remaining.length === 0) {
      yield done;
      return;
    }
    for (const candidate of remaining) {
      if (candidate.preds.every((p) => done.includes(byId.get(p)))) {
        yield* linearExtensions(
          [...done, candidate],
          remaining.filter((r) => r !== candidate),
        );
      }
    }
  }

  const agvs = ['A', 'B', 'C', 'D', 'E'];
  let reference = null;
  let count = 0;
  for (const order of linearExtensions([], events)) {
    count += 1;
    const summary = replay(order.map((o) => o.ev), agvs);
    const finals = normalizedTasks(summary);
    assert.equal(finals.T1.holder, 'B', 'chain resolves to the causally latest claim');
    assert.equal(finals.T2.holder, 'E', 'resolver dominates the concurrent pair');
    if (!reference) reference = finals;
    else assert.deepEqual(finals, reference, `linear extension ${count} diverged`);
  }
  assert.ok(count > 1, `enumerated ${count} distinct causal schedules`);
});
