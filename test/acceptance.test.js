import test from 'node:test';
import assert from 'node:assert/strict';
import { findWitnesses } from '../src/checker.js';
import { minimalConflict } from '../src/conflict.js';
import { verifyWitness } from '../src/brute.js';

const hold = (id, invoke, respond, amount, deadline = 50) => ({
  id, op: 'hold', invoke, respond, clock: 0, version: 1, amount, deadline,
  response: { ok: true, holdId: `H-${id}` },
});
const capture = (id, holdOp, invoke, respond, amount, totalCaptured) => ({
  id, op: 'capture', holdId: `H-${holdOp}`, invoke, respond, clock: 0, version: 1, amount,
  response: { ok: true, totalCaptured },
});
const cancel = (id, holdOp, invoke, respond, released) => ({
  id, op: 'cancel', holdId: `H-${holdOp}`, invoke, respond, clock: 0, version: 1,
  response: { ok: true, released },
});
const audit = (id, holdOp, invoke, respond, frozen, captured, available) => ({
  id, op: 'audit', holdId: `H-${holdOp}`, invoke, respond, clock: 0, version: 1,
  response: { ok: true, frozen, captured, available },
});

test('overlapping audits may observe any legal intermediate state', () => {
  const ops = [
    hold('h', 0, 1, 100),
    capture('c', 'h', 2, 8, 40, 40),
    audit('a-before', 'h', 3, 5, 100, 0, 100),
    audit('a-after', 'h', 6, 7, 60, 40, 60),
  ];
  const [witness] = findWitnesses(ops, { limit: 1 });
  assert.ok(witness, 'expected a linearization witness');
  assert.deepEqual(witness.audits['a-before'], { frozen: 100, captured: 0, available: 100 });
  assert.deepEqual(witness.audits['a-after'], { frozen: 60, captured: 40, available: 60 });
  assert.ok(verifyWitness(ops, witness));
});

test('an audit overlapping a capture can read either side of it', () => {
  const base = [hold('h', 0, 1, 100), capture('c', 'h', 2, 8, 40, 40)];
  const seesBefore = [...base, audit('a', 'h', 3, 7, 100, 0, 100)];
  const seesAfter = [...base, audit('a', 'h', 3, 7, 60, 40, 60)];
  assert.equal(findWitnesses(seesBefore, { limit: 1 }).length, 1);
  assert.equal(findWitnesses(seesAfter, { limit: 1 }).length, 1);
});

test('an audit cannot observe a state that never existed', () => {
  const ops = [
    hold('h', 0, 1, 100),
    capture('c', 'h', 2, 8, 40, 40),
    audit('a', 'h', 3, 7, 80, 20, 80),
  ];
  assert.equal(findWitnesses(ops, { limit: 1 }).length, 0);
});

test('capture after cancel is not linearizable; conflict names both', () => {
  const ops = [
    hold('h', 0, 2, 100),
    cancel('x', 'h', 3, 5, 100),
    capture('c', 'h', 6, 8, 50, 50),
  ];
  assert.equal(findWitnesses(ops, { limit: 1 }).length, 0);
  const conflict = minimalConflict(ops);
  assert.ok(conflict.includes('x'), `conflict ${conflict} must include the cancel`);
  assert.ok(conflict.includes('c'), `conflict ${conflict} must include the capture`);
});

test('partial capture then cancel releases only the remainder', () => {
  const ops = [
    hold('h', 0, 2, 100),
    capture('c', 'h', 3, 5, 30, 30),
    cancel('x', 'h', 6, 8, 70),
    audit('a', 'h', 9, 10, 0, 30, 0),
  ];
  const [witness] = findWitnesses(ops, { limit: 1 });
  assert.ok(witness, 'expected a linearization witness');
  assert.equal(witness.allocations.c, 30);
  assert.deepEqual(witness.audits.a, { frozen: 0, captured: 30, available: 0 });
  assert.ok(verifyWitness(ops, witness));
});

test('cancel releasing more than the remainder is rejected', () => {
  const ops = [
    hold('h', 0, 2, 100),
    capture('c', 'h', 3, 5, 30, 30),
    cancel('x', 'h', 6, 8, 100),
  ];
  assert.equal(findWitnesses(ops, { limit: 1 }).length, 0);
  const conflict = minimalConflict(ops);
  assert.ok(conflict.includes('c'));
  assert.ok(conflict.includes('x'));
});

test('multiple captures accumulate against the same hold', () => {
  const ops = [
    hold('h', 0, 1, 100),
    capture('c1', 'h', 2, 4, 30, 30),
    capture('c2', 'h', 5, 7, 50, 80),
    audit('a', 'h', 8, 9, 20, 80, 20),
  ];
  const [witness] = findWitnesses(ops, { limit: 1 });
  assert.ok(witness);
  assert.equal(witness.allocations.c1, 30);
  assert.equal(witness.allocations.c2, 50);
  assert.ok(verifyWitness(ops, witness));
});

test('capture beyond the held amount is not linearizable', () => {
  const ops = [
    hold('h', 0, 1, 100),
    capture('c1', 'h', 2, 4, 60, 60),
    capture('c2', 'h', 5, 7, 60, 120),
  ];
  assert.equal(findWitnesses(ops, { limit: 1 }).length, 0);
});

test('failed capture responses are honored', () => {
  const cancelled = [
    hold('h', 0, 1, 100),
    cancel('x', 'h', 2, 3, 100),
    { id: 'c', op: 'capture', holdId: 'H-h', invoke: 4, respond: 5, clock: 0, version: 1,
      amount: 10, response: { ok: false, error: 'cancelled' } },
  ];
  assert.equal(findWitnesses(cancelled, { limit: 1 }).length, 1);
});
