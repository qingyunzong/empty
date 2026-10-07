import test from 'node:test';
import assert from 'node:assert/strict';
import { ClearingHouse } from '../src/engine.js';

const inst = (id, over = {}) => ({
  id,
  institution: 'A',
  amount: 10,
  priority: 1,
  deadline: 1,
  deps: [],
  ...over,
});

test('capacity conflict fails with CAPACITY errors', () => {
  const house = new ClearingHouse({ slots: 1, capacity: 1 });
  const report = house.schedule([
    inst('x1', { institution: 'A', priority: 3 }),
    inst('x2', { institution: 'B', priority: 2 }),
    inst('x3', { institution: 'C', priority: 1 }),
  ]);
  assert.equal(report.schedule.length, 1);
  assert.equal(report.schedule[0].id, 'x1');
  const codes = report.errors.filter((e) => e.code === 'CAPACITY').map((e) => e.id).sort();
  assert.deepEqual(codes, ['x2', 'x3']);
});

test('institution quota caps scheduling and reports QUOTA', () => {
  const house = new ClearingHouse({ slots: 3, capacity: 3, quotas: { A: 1 } });
  const report = house.schedule([
    inst('a1', { institution: 'A', priority: 5, deadline: 3 }),
    inst('a2', { institution: 'A', priority: 4, deadline: 3 }),
    inst('b1', { institution: 'B', priority: 1, deadline: 3 }),
  ]);
  const ids = report.schedule.map((s) => s.id).sort();
  assert.deepEqual(ids, ['a1', 'b1']);
  const quotaErrors = report.errors.filter((e) => e.code === 'QUOTA');
  assert.equal(quotaErrors.length, 1);
  assert.equal(quotaErrors[0].id, 'a2');
});

test('quotas enforce global fairness across institutions', () => {
  const house = new ClearingHouse({ slots: 5, capacity: 5, quotas: { A: 1, B: 2 } });
  const report = house.schedule([
    inst('a1', { institution: 'A', priority: 9, deadline: 5 }),
    inst('a2', { institution: 'A', priority: 8, deadline: 5 }),
    inst('a3', { institution: 'A', priority: 7, deadline: 5 }),
    inst('b1', { institution: 'B', priority: 1, deadline: 5 }),
    inst('b2', { institution: 'B', priority: 1, deadline: 5 }),
  ]);
  const perInst = { A: 0, B: 0 };
  for (const s of report.schedule) perInst[s.institution] += 1;
  assert.deepEqual(perInst, { A: 1, B: 2 });
});

test('starvation aging lets an aged low-priority instruction win', () => {
  const aged = new ClearingHouse({ slots: 1, capacity: 1, agingFactor: 1 });
  const report = aged.schedule([
    inst('fresh', { priority: 5, age: 0 }),
    inst('old', { priority: 4, age: 2 }),
  ]);
  assert.equal(report.schedule[0].id, 'old');
  assert.equal(report.schedule[0].effectivePriority, 6);

  const noAging = new ClearingHouse({ slots: 1, capacity: 1, agingFactor: 0 });
  const report2 = noAging.schedule([
    inst('fresh', { priority: 5, age: 0 }),
    inst('old', { priority: 4, age: 2 }),
  ]);
  assert.equal(report2.schedule[0].id, 'fresh');
});

test('waitlisted instructions accumulate age across rounds and get scheduled', () => {
  const house = new ClearingHouse({ slots: 1, capacity: 1, agingFactor: 1 });
  const first = house.schedule([
    inst('strong', { priority: 5, amount: 10 }),
    inst('weak', { priority: 4, amount: 100 }),
  ]);
  assert.equal(first.schedule[0].id, 'strong');
  assert.deepEqual(first.waitlist, ['weak']);
  // Next daily round: weak ages to effective priority 5 and wins the
  // amount tie-break, preempting the incumbent.
  const second = house.schedule([]);
  assert.equal(second.schedule[0].id, 'weak');
  const preempt = second.certificates.find((c) => c.type === 'PREEMPT');
  assert.equal(preempt.instruction.id, 'strong');
});

test('dependency cycles are rejected with CYCLE', () => {
  const house = new ClearingHouse({ slots: 3, capacity: 1 });
  const report = house.schedule([
    inst('a', { deps: ['b'], deadline: 2 }),
    inst('b', { deps: ['a'], deadline: 3 }),
    inst('c', { deadline: 1 }),
  ]);
  const cycleErrors = report.errors.filter((e) => e.code === 'CYCLE').map((e) => e.id).sort();
  assert.deepEqual(cycleErrors, ['a', 'b']);
  assert.deepEqual(report.schedule.map((s) => s.id), ['c']);
});

test('self dependency is a CYCLE error', () => {
  const house = new ClearingHouse({ slots: 1, capacity: 1 });
  const report = house.schedule([inst('loop', { deps: ['loop'] })]);
  assert.equal(report.errors[0].code, 'CYCLE');
  assert.equal(report.schedule.length, 0);
});

test('unknown dependencies are rejected with UNKNOWN_DEP', () => {
  const house = new ClearingHouse({ slots: 2, capacity: 1 });
  const report = house.schedule([inst('d', { deps: ['ghost'], deadline: 2 })]);
  assert.equal(report.errors[0].code, 'UNKNOWN_DEP');
  assert.equal(report.schedule.length, 0);
});

test('dependency chains occupy strictly increasing slots', () => {
  const house = new ClearingHouse({ slots: 3, capacity: 1 });
  const report = house.schedule([
    inst('a', { deadline: 1 }),
    inst('b', { deps: ['a'], deadline: 2 }),
    inst('c', { deps: ['b'], deadline: 3 }),
  ]);
  const slots = Object.fromEntries(report.schedule.map((s) => [s.id, s.slot]));
  assert.deepEqual(slots, { a: 1, b: 2, c: 3 });
});
