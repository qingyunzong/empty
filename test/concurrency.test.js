// Acceptance 1: three AGVs concurrently claim one task -> deterministic final
// state under every arrival order, and a causally-later resolver claim wins
// deterministically.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';

const JOINS = ['A', 'B', 'C', 'D'].map((agv) => ({ type: 'join', agv, ts: 0 }));

const CONCURRENT_CLAIMS = [
  { type: 'claim', task: 'T1', agv: 'A', epoch: 1, ttl: 100, ts: 1, clock: { A: 1 } },
  { type: 'claim', task: 'T1', agv: 'B', epoch: 1, ttl: 100, ts: 2, clock: { B: 1 } },
  { type: 'claim', task: 'T1', agv: 'C', epoch: 1, ttl: 100, ts: 3, clock: { C: 1 } },
];

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

function replay(events) {
  const engine = new Engine();
  for (const ev of [...JOINS, ...events]) engine.applyEvent(ev);
  return engine;
}

function normalizedTask(summary, task) {
  const t = summary.tasks[task];
  return {
    status: t.status,
    holder: t.holder,
    epoch: t.epoch,
    leaseStatus: t.leaseStatus,
    contested: t.contested,
    frontier: t.frontier.map((c) => ({ agv: c.agv, epoch: c.epoch })).sort((x, y) => x.agv.localeCompare(y.agv)),
  };
}

test('acceptance 1: concurrent claims never fail; task stays pending, order-invariant', () => {
  const finals = [];
  for (const perm of permutations(CONCURRENT_CLAIMS)) {
    const summary = replay(perm).summary();
    const t = summary.tasks.T1;
    assert.equal(t.status, 'pending', 'incomparable claims keep the task pending');
    assert.equal(t.holder, null, 'no owner while claims are causally concurrent');
    assert.equal(t.leaseStatus, 'revoked', 'unsafe early grant is revoked');
    assert.equal(t.contested, true);
    assert.equal(t.frontier.length, 3);
    finals.push(normalizedTask(summary, 'T1'));
  }
  assert.equal(finals.length, 6, '3! arrival orders enumerated');
  for (const final of finals) assert.deepEqual(final, finals[0], 'final state is identical for every order');
});

test('acceptance 1b: a claim dominating all concurrent claims wins deterministically', () => {
  const resolver = { type: 'claim', task: 'T1', agv: 'D', epoch: 2, ttl: 100, ts: 10, clock: { A: 1, B: 1, C: 1, D: 1 } };
  const finals = [];
  for (const perm of permutations(CONCURRENT_CLAIMS)) {
    const engine = replay(perm);
    const res = engine.applyEvent(resolver);
    assert.equal(res.decision, 'granted');
    const t = engine.summary().tasks.T1;
    assert.equal(t.status, 'granted');
    assert.equal(t.holder, 'D');
    assert.equal(t.leaseStatus, 'active');
    assert.equal(t.contested, false);
    finals.push(normalizedTask(engine.summary(), 'T1'));
  }
  for (const final of finals) assert.deepEqual(final, finals[0]);
});

test('causally ordered claims: the latest dominating claim holds the task', () => {
  const engine = replay([
    { type: 'claim', task: 'T1', agv: 'A', epoch: 1, ttl: 10, ts: 0, clock: { A: 1 } },
    { type: 'claim', task: 'T1', agv: 'B', epoch: 2, ttl: 10, ts: 20, clock: { A: 1, B: 1 } },
    { type: 'claim', task: 'T1', agv: 'C', epoch: 3, ttl: 10, ts: 40, clock: { A: 1, B: 1, C: 1 } },
  ]);
  const t = engine.summary().tasks.T1;
  assert.equal(t.status, 'granted');
  assert.equal(t.holder, 'C');
  assert.equal(t.epoch, 3);
});
