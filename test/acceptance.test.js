'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run, InputError } = require('../lib/engine');

const TIERS = [1, 0.75, 0.5, 0.25];

test('acceptance 1: two cards partially approved under one shared limit', () => {
  const out = run({
    sharedLimit: 1000,
    tiers: TIERS,
    cards: [
      { id: 'A', limit: 600, categories: ['dining'] },
      { id: 'B', limit: 600, categories: ['travel'] },
    ],
    events: [
      { type: 'auth', id: 'r1', card: 'A', amount: 600, category: 'dining' },
      { type: 'auth', id: 'r2', card: 'B', amount: 600, category: 'travel' },
    ],
  });
  const [d1, d2] = out.decisions;
  assert.equal(d1.decision, 'APPROVED_FULL');
  assert.equal(d1.approved, 600);
  assert.equal(d1.shortfall, 0);
  assert.equal(d2.decision, 'APPROVED_PARTIAL');
  assert.equal(d2.approved, 300);
  assert.equal(d2.shortfall, 300);
  assert.equal(d2.tier, 0.5);
  assert.deepEqual(out.freezes, { shared: 900, cards: { A: 600, B: 300 } });
  assert.deepEqual(out.waiting, []);
});

test('acceptance 2: reversal releases shared limit and approves waiting order', () => {
  const out = run({
    sharedLimit: 1000,
    tiers: TIERS,
    cards: [
      { id: 'A', limit: 1000 },
      { id: 'B', limit: 1000 },
    ],
    events: [
      { type: 'auth', id: 'r1', card: 'A', amount: 900 },
      { type: 'auth', id: 'r2', card: 'B', amount: 1000 },
      { type: 'reversal', auth: 'r1', amount: 400 },
    ],
  });
  const [d1, d2, d3] = out.decisions;
  assert.equal(d1.decision, 'APPROVED_FULL');
  assert.equal(d2.decision, 'UNSAT');
  assert.deepEqual(d2.conflictCards, ['A']);
  assert.equal(d3.type, 'reversal');
  assert.equal(d3.restored, 400);
  assert.equal(d3.remainingApproved, 500);
  assert.equal(d3.retry.status, 'SOLVED');
  assert.deepEqual(d3.retry.placements, [
    { id: 'r2', card: 'B', decision: 'APPROVED_PARTIAL', approved: 500, shortfall: 500 },
  ]);
  assert.deepEqual(out.freezes, { shared: 1000, cards: { A: 500, B: 500 } });
  assert.deepEqual(out.restored, { total: 400, byAuth: { r1: 400 } });
  assert.deepEqual(out.waiting, []);
});

test('acceptance 3: card-layer limit conflict yields UNSAT with conflict cards', () => {
  const out = run({
    sharedLimit: 1000,
    tiers: TIERS,
    cards: [
      { id: 'A', limit: 100 },
      { id: 'B', limit: 200 },
    ],
    events: [
      { type: 'auth', id: 'r1', card: 'A', amount: 500 },
      { type: 'auth', id: 'r2', card: 'B', amount: 50 },
    ],
  });
  const [d1, d2] = out.decisions;
  assert.equal(d1.decision, 'UNSAT');
  assert.equal(d1.approved, 0);
  assert.equal(d1.shortfall, 500);
  assert.deepEqual(d1.conflictCards, ['A']);
  assert.equal(d1.explanation.length, 4);
  for (const tier of d1.explanation) {
    assert.deepEqual(tier.blockedBy, [{ layer: 'card', card: 'A', remaining: 100 }]);
  }
  assert.equal(d2.decision, 'APPROVED_FULL');
  assert.deepEqual(out.waiting, [{ id: 'r1', card: 'A', amount: 500 }]);
  assert.deepEqual(out.freezes, { shared: 50, cards: { A: 0, B: 50 } });
});

test('acceptance 4: exhausted node budget yields PENDING, not UNSAT', () => {
  const out = run({
    sharedLimit: 1000,
    budget: 1,
    tiers: TIERS,
    cards: [
      { id: 'A', limit: 1000 },
      { id: 'B', limit: 1000 },
    ],
    events: [
      { type: 'auth', id: 'r1', card: 'A', amount: 600 },
      { type: 'auth', id: 'r2', card: 'B', amount: 600 },
    ],
  });
  const [d1, d2] = out.decisions;
  assert.equal(d1.decision, 'APPROVED_FULL');
  assert.equal(d2.decision, 'PENDING');
  assert.equal(d2.approved, 0);
  assert.equal(d2.shortfall, 600);
  assert.deepEqual(out.waiting, [{ id: 'r2', card: 'B', amount: 600 }]);
  assert.deepEqual(out.freezes, { shared: 600, cards: { A: 600, B: 0 } });
});

test('pending authorizations on the same card count toward its limit', () => {
  const out = run({
    sharedLimit: 10000,
    tiers: TIERS,
    cards: [{ id: 'A', limit: 500 }],
    events: [
      { type: 'auth', id: 'r1', card: 'A', amount: 300 },
      { type: 'auth', id: 'r2', card: 'A', amount: 300 },
    ],
  });
  assert.equal(out.decisions[0].decision, 'APPROVED_FULL');
  assert.equal(out.decisions[1].decision, 'APPROVED_PARTIAL');
  assert.equal(out.decisions[1].approved, 150);
  assert.equal(out.decisions[1].shortfall, 150);
  assert.deepEqual(out.freezes, { shared: 450, cards: { A: 450 } });
});

test('reversal restores per authorization history and may be partial', () => {
  const out = run({
    sharedLimit: 1000,
    tiers: TIERS,
    cards: [{ id: 'A', limit: 1000 }],
    events: [
      { type: 'auth', id: 'r1', card: 'A', amount: 400 },
      { type: 'reversal', auth: 'r1', amount: 150 },
      { type: 'reversal', auth: 'r1', amount: 250 },
    ],
  });
  assert.equal(out.decisions[1].restored, 150);
  assert.equal(out.decisions[2].restored, 250);
  assert.deepEqual(out.restored, { total: 400, byAuth: { r1: 400 } });
  assert.deepEqual(out.freezes, { shared: 0, cards: { A: 0 } });
});

test('reversal exceeding remaining approved amount is rejected', () => {
  assert.throws(
    () =>
      run({
        sharedLimit: 1000,
        cards: [{ id: 'A', limit: 1000 }],
        events: [
          { type: 'auth', id: 'r1', card: 'A', amount: 300 },
          { type: 'reversal', auth: 'r1', amount: 200 },
          { type: 'reversal', auth: 'r1', amount: 200 },
        ],
      }),
    InputError,
  );
});

test('unknown card and unknown authorization are rejected', () => {
  assert.throws(
    () =>
      run({
        sharedLimit: 1000,
        cards: [{ id: 'A', limit: 1000 }],
        events: [{ type: 'auth', id: 'r1', card: 'ZZZ', amount: 10 }],
      }),
    /unknown card/,
  );
  assert.throws(
    () =>
      run({
        sharedLimit: 1000,
        cards: [{ id: 'A', limit: 1000 }],
        events: [{ type: 'reversal', auth: 'nope', amount: 10 }],
      }),
    /unknown authorization/,
  );
});

test('merchant category not allowed on card is declined without search', () => {
  const out = run({
    sharedLimit: 1000,
    tiers: TIERS,
    cards: [{ id: 'A', limit: 1000, categories: ['dining'] }],
    events: [{ type: 'auth', id: 'r1', card: 'A', amount: 100, category: 'gambling' }],
  });
  assert.equal(out.decisions[0].decision, 'DECLINED');
  assert.equal(out.decisions[0].reason, 'CATEGORY_NOT_ALLOWED');
  assert.deepEqual(out.freezes, { shared: 0, cards: { A: 0 } });
});
