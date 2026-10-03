'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');

const lastDecision = (out, id) => {
  const list = out.decisions.filter((d) => d.id === id);
  return list[list.length - 1];
};

test('acceptance 1: shared limit, two cards, partial approval', () => {
  const out = new Engine({
    sharedLimit: 1000,
    cards: { A: { limit: 600 }, B: { limit: 500 } },
    tiers: [1, 0.5, 0.25],
    operations: [
      { type: 'auth', id: 'a1', card: 'A', amount: 400, category: 'dining' },
      { type: 'auth', id: 'a2', card: 'B', amount: 700, category: 'dining' },
    ],
  }).run();

  assert.equal(out.status, 'OK');
  assert.deepEqual(
    { ...lastDecision(out, 'a1'), seq: undefined },
    { seq: undefined, id: 'a1', card: 'A', category: 'dining', requested: 400, approved: 400, pendingDiff: 0, status: 'APPROVED' },
  );
  const d2 = lastDecision(out, 'a2');
  assert.equal(d2.status, 'PARTIAL');
  assert.equal(d2.approved, 350); // highest tier fitting card B (500) and shared remainder (600)
  assert.equal(d2.pendingDiff, 350); // unresolved difference returned
  assert.equal(out.freezes.shared.used, 750);
  assert.equal(out.freezes.cards.A.used, 400);
  assert.equal(out.freezes.cards.B.used, 350);
  assert.equal(out.freezes.categories.dining, undefined); // no category limit configured
});

test('acceptance 2: reversal releases capacity and approves the waiting order', () => {
  const out = new Engine({
    sharedLimit: 500,
    cards: { A: { limit: 500 }, B: { limit: 500 } },
    operations: [
      { type: 'auth', id: 'a1', card: 'A', amount: 500 },
      { type: 'auth', id: 'a2', card: 'B', amount: 300 },
      { type: 'reverse', authId: 'a1', amount: 300 },
    ],
  }).run();

  assert.equal(lastDecision(out, 'a1').status, 'APPROVED');
  const declined = out.decisions.find((d) => d.id === 'a2');
  assert.equal(declined.status, 'DECLINED'); // shared layer exhausted -> waits
  const released = lastDecision(out, 'a2');
  assert.equal(released.status, 'APPROVED');
  assert.equal(released.approved, 300);
  assert.equal(released.fromWaitlist, true);
  assert.equal(released.releasedBy, 'a1');
  assert.deepEqual(out.reversals, [
    { authId: 'a1', restored: 300, remainingApproved: 200, releasedApprovals: ['a2'] },
  ]);
  assert.equal(out.freezes.shared.used, 500); // 200 remaining on a1 + 300 on a2
  assert.deepEqual(out.waiting, []);
});

test('acceptance 3: layer limit conflict yields UNSAT with conflict card set', () => {
  const out = new Engine({
    sharedLimit: 100,
    cards: { A: { limit: 200 }, B: { limit: 200 } },
    operations: [
      { type: 'auth', id: 'a0', card: 'B', amount: 80 },
      { type: 'auth', id: 'a1', card: 'A', amount: 150, required: true },
    ],
  }).run();

  assert.equal(out.status, 'UNSAT');
  const d = lastDecision(out, 'a1');
  assert.equal(d.status, 'DECLINED');
  assert.equal(d.reason, 'UNSAT');
  // shared layer (remaining 20) blocks the required minimum tier (37);
  // B holds an active freeze in the shared layer, so both cards explain the conflict.
  assert.deepEqual(out.conflictCards, ['A', 'B']);
});

test('acceptance 4: exhausted node budget yields PENDING, not UNSAT', () => {
  const out = new Engine({
    sharedLimit: 1000,
    budget: 1,
    cards: { A: { limit: 1000 }, B: { limit: 1000 }, C: { limit: 1000 } },
    operations: [
      {
        type: 'auth',
        requests: [
          { id: 'a1', card: 'A', amount: 100 },
          { id: 'a2', card: 'B', amount: 100 },
          { id: 'a3', card: 'C', amount: 100 },
        ],
      },
    ],
  }).run();

  assert.equal(out.status, 'PENDING');
  assert.deepEqual(out.decisions.map((d) => d.status), ['PENDING', 'PENDING', 'PENDING']);
  assert.deepEqual(out.waiting, ['a1', 'a2', 'a3']);
  assert.equal(out.freezes.shared.used, 0); // nothing frozen while pending
});

test('same scenario with enough budget is solvable (PENDING is budget-only)', () => {
  const out = new Engine({
    sharedLimit: 1000,
    budget: 100,
    cards: { A: { limit: 1000 }, B: { limit: 1000 }, C: { limit: 1000 } },
    operations: [
      {
        type: 'auth',
        requests: [
          { id: 'a1', card: 'A', amount: 100 },
          { id: 'a2', card: 'B', amount: 100 },
          { id: 'a3', card: 'C', amount: 100 },
        ],
      },
    ],
  }).run();
  assert.equal(out.status, 'OK');
  assert.deepEqual(out.decisions.map((d) => d.status), ['APPROVED', 'APPROVED', 'APPROVED']);
});
