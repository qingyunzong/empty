'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, InputError } = require('../src/engine');
const { solve, candidateAmounts } = require('../src/solver');

test('candidateAmounts enumerates full, preset tiers, and decline', () => {
  assert.deepEqual(candidateAmounts(700, [1, 0.5, 0.25], false), [700, 350, 175, 0]);
  assert.deepEqual(candidateAmounts(700, [1, 0.5, 0.25], true), [700, 350, 175]);
  assert.deepEqual(candidateAmounts(100, [1], false), [100, 0]);
});

test('solver returns UNSAT only after exhaustive enumeration', () => {
  const limits = new Map([['shared', 30], ['card:A', 200]]);
  const used = new Map([['shared', 0], ['card:A', 0]]);
  const requests = [
    { id: 'r', card: 'A', amount: 150, required: true, layers: ['shared', 'card:A'] },
  ];
  const result = solve(requests, limits, used, [1, 0.5, 0.25], 100000);
  assert.equal(result.status, 'UNSAT');
});

test('solver returns PENDING when the node budget runs out mid-search', () => {
  const limits = new Map([['shared', 60], ['card:A', 1000]]);
  const used = new Map([['shared', 0], ['card:A', 0]]);
  const requests = [
    { id: 'r', card: 'A', amount: 100, required: false, layers: ['shared', 'card:A'] },
  ];
  const result = solve(requests, limits, used, [1, 0.5], 1);
  assert.equal(result.status, 'PENDING');
});

test('pending authorizations on the same card count toward occupancy', () => {
  const out = new Engine({
    sharedLimit: 10000,
    cards: { A: { limit: 500 } },
    operations: [
      { type: 'auth', id: 'a1', card: 'A', amount: 300 },
      { type: 'auth', id: 'a2', card: 'A', amount: 300 },
    ],
  }).run();
  const d2 = out.decisions.find((d) => d.id === 'a2');
  assert.equal(d2.status, 'PARTIAL');
  assert.equal(d2.approved, 150); // card layer has only 200 left; 300 fails, tier 150 fits
  assert.equal(d2.pendingDiff, 150);
  assert.equal(out.freezes.cards.A.used, 450);
});

test('category layer limit is enforced alongside shared and card layers', () => {
  const out = new Engine({
    sharedLimit: 10000,
    cards: { A: { limit: 1000 } },
    categoryLimits: { fuel: 100 },
    operations: [{ type: 'auth', id: 'a1', card: 'A', amount: 400, category: 'fuel' }],
  }).run();
  const d = out.decisions[0];
  assert.equal(d.status, 'PARTIAL');
  assert.equal(d.approved, 100); // 400/200 fail on category layer, tier 100 fits
  assert.equal(out.freezes.categories.fuel.used, 100);
});

test('partial reversal restores every layer and cannot exceed the original approval', () => {
  const engine = new Engine({
    sharedLimit: 1000,
    cards: { A: { limit: 1000 } },
    categoryLimits: { dining: 1000 },
    operations: [
      { type: 'auth', id: 'a1', card: 'A', amount: 400, category: 'dining' },
      { type: 'reverse', authId: 'a1', amount: 150 },
    ],
  });
  const out = engine.run();
  assert.deepEqual(out.reversals, [
    { authId: 'a1', restored: 150, remainingApproved: 250, releasedApprovals: [] },
  ]);
  assert.equal(out.freezes.shared.used, 250);
  assert.equal(out.freezes.cards.A.used, 250);
  assert.equal(out.freezes.categories.dining.used, 250);

  const over = new Engine({
    sharedLimit: 1000,
    cards: { A: { limit: 1000 } },
    operations: [
      { type: 'auth', id: 'a1', card: 'A', amount: 400 },
      { type: 'reverse', authId: 'a1', amount: 250 },
      { type: 'reverse', authId: 'a1', amount: 200 }, // 250+200 > 400 approved
    ],
  });
  assert.throws(() => over.run(), InputError);
});

test('full reversal defaults to the remaining approved amount', () => {
  const out = new Engine({
    sharedLimit: 1000,
    cards: { A: { limit: 1000 } },
    operations: [
      { type: 'auth', id: 'a1', card: 'A', amount: 400 },
      { type: 'reverse', authId: 'a1' },
    ],
  }).run();
  assert.equal(out.reversals[0].restored, 400);
  assert.equal(out.freezes.shared.used, 0);
});

test('unknown card and unknown authorization raise InputError', () => {
  assert.throws(
    () =>
      new Engine({
        sharedLimit: 100,
        cards: { A: { limit: 100 } },
        operations: [{ type: 'auth', id: 'x', card: 'NOPE', amount: 10 }],
      }).run(),
    /unknown card: NOPE/,
  );
  assert.throws(
    () =>
      new Engine({
        sharedLimit: 100,
        cards: { A: { limit: 100 } },
        operations: [{ type: 'reverse', authId: 'ghost', amount: 10 }],
      }).run(),
    /unknown authorization: ghost/,
  );
});

test('waiting order is retried in FIFO order and stays waiting while capacity is short', () => {
  const out = new Engine({
    sharedLimit: 300,
    cards: { A: { limit: 300 }, B: { limit: 300 }, C: { limit: 300 } },
    operations: [
      { type: 'auth', id: 'a1', card: 'A', amount: 300 },
      { type: 'auth', id: 'w1', card: 'B', amount: 200 },
      { type: 'auth', id: 'w2', card: 'C', amount: 100 },
      { type: 'reverse', authId: 'a1', amount: 100 },
      { type: 'reverse', authId: 'a1', amount: 100 },
    ],
  }).run();
  // First release of 100: head of the queue w1 takes a partial tier, w2 keeps waiting.
  const w1 = out.decisions.filter((d) => d.id === 'w1').pop();
  assert.equal(w1.status, 'PARTIAL');
  assert.equal(w1.approved, 100);
  assert.equal(w1.pendingDiff, 100);
  assert.equal(w1.fromWaitlist, true);
  assert.equal(w1.releasedBy, 'a1');
  // Second release of 100: w2 is now fully approved.
  const w2 = out.decisions.filter((d) => d.id === 'w2').pop();
  assert.equal(w2.status, 'APPROVED');
  assert.equal(w2.approved, 100);
  assert.deepEqual(out.reversals[0].releasedApprovals, ['w1']);
  assert.deepEqual(out.reversals[1].releasedApprovals, ['w2']);
  assert.deepEqual(out.waiting, []);
});
