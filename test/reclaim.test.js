import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from '../src/scheduler.js';

const tree = () => [
  { id: 'R', parent: null, guarantee: 2 },
  { id: 'A', parent: 'R', guarantee: 2 },
  { id: 'B', parent: 'R', guarantee: 0 },
  { id: 'C', parent: 'B', guarantee: 0 },
];

test('reclaim triggers multi-level rollback and releases the exact amount', () => {
  const report = simulate({
    config: { trace: true },
    tenants: tree(),
    orders: [
      { id: 'c1', tenant: 'C', duration: 5 },
      { id: 'c2', tenant: 'C', duration: 5 },
    ],
    commands: [
      { tick: 2, type: 'submit', order: { id: 'a1', tenant: 'A', duration: 3 } },
      { tick: 2, type: 'submit', order: { id: 'a2', tenant: 'A', duration: 3 } },
      { tick: 2, type: 'reclaim', tenant: 'A', amount: 2 },
    ],
    horizon: 5,
  });

  // borrow chain: C borrowed 2 slots from A at tick 0
  assert.equal(report.borrowChain.length, 2);
  assert.ok(report.borrowChain.every((r) => r.lender === 'A' && r.borrower === 'C'));

  // preemption: exactly 2 slots released, no more no less
  assert.equal(report.preemptions.length, 2);
  assert.equal(report.preemptions.reduce((s, p) => s + p.released, 0), 2);
  assert.ok(report.preemptions.every((p) => p.tick === 2 && p.reason === 'reclaim'));
  assert.ok(report.borrowChain.every((r) => r.status === 'preempted'));

  // before reclaim (tick 1): usage recorded level by level C -> B -> R
  const t1 = report.schedule[1].nodes;
  assert.equal(t1.C.usage, 2);
  assert.equal(t1.B.usage, 2);
  assert.equal(t1.R.usage, 2);
  assert.equal(t1.A.lentOut, 2);
  assert.equal(t1.B.borrowedIn, 2);
  assert.equal(t1.C.borrowedIn, 2);

  // after reclaim (tick 2): rolled back level by level, A reuses exactly the freed 2 slots
  const t2 = report.schedule[2].nodes;
  assert.equal(t2.C.usage, 0);
  assert.equal(t2.B.usage, 0);
  assert.equal(t2.A.lentOut, 0);
  assert.equal(t2.B.borrowedIn, 0);
  assert.equal(t2.C.borrowedIn, 0);
  assert.equal(t2.A.usage, 2); // a1 + a2 running on reclaimed quota
  assert.equal(t2.R.usage, 2);

  // no node ever exceeds its quota at any level
  for (const ev of report.schedule) {
    for (const [id, s] of Object.entries(ev.nodes)) {
      assert.ok(s.slack >= 0, `tick ${ev.tick}: node ${id} over quota`);
    }
  }

  // preempted orders were rolled back (progress revoked, back to waiting)
  const c1 = report.orders.find((o) => o.id === 'c1');
  assert.equal(c1.preempts, 1);
  assert.equal(c1.progress, 0);
});

test('partial reclaim releases exactly the requested amount', () => {
  const report = simulate({
    config: { trace: true },
    tenants: tree(),
    orders: [
      { id: 'c1', tenant: 'C', duration: 5, priority: 0 },
      { id: 'c2', tenant: 'C', duration: 5, priority: 9 },
    ],
    commands: [{ tick: 2, type: 'reclaim', tenant: 'A', amount: 1 }],
    horizon: 6,
  });
  assert.equal(report.preemptions.length, 1);
  assert.equal(report.preemptions[0].released, 1);
  // lowest priority borrower is preempted first
  assert.equal(report.preemptions[0].orderId, 'c1');
  // exactly one borrow record was rolled back, and it is c1's
  const preemptedRecs = report.borrowChain.filter((r) => r.status === 'preempted');
  assert.equal(preemptedRecs.length, 1);
  assert.equal(preemptedRecs[0].orderId, 'c1');
  // c2's loan is untouched
  const c2rec = report.borrowChain.find((r) => r.orderId === 'c2');
  assert.equal(c2rec.status, 'completed');
  // surviving order keeps running and completes on schedule (started tick 0, duration 5)
  const c2 = report.orders.find((o) => o.id === 'c2');
  assert.equal(c2.status, 'completed');
  assert.equal(c2.finishTick, 4);
  // after rollback every node is within quota
  for (const n of report.nodes) assert.ok(n.slack >= 0, `node ${n.id} over quota`);
});

test('latest borrow is preempted first', () => {
  const report = simulate({
    tenants: [
      { id: 'R', parent: null, guarantee: 2 },
      { id: 'A', parent: 'R', guarantee: 2 },
      { id: 'B', parent: 'R', guarantee: 0 },
    ],
    orders: [
      { id: 'early', tenant: 'B', duration: 10, priority: 0 },
      { id: 'late', tenant: 'B', duration: 10, priority: 5, arrive: 1 },
    ],
    commands: [{ tick: 3, type: 'reclaim', tenant: 'A', amount: 1 }],
    horizon: 4,
  });
  // only one slot per tick is lendable, so "early" borrows at tick 0 and
  // "late" borrows at... A has 2 slots: both borrow, "late" at tick 1.
  assert.equal(report.preemptions.length, 1);
  assert.equal(report.preemptions[0].orderId, 'late', 'latest borrow preempted first');
});
