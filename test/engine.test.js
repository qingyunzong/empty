import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NettingEngine } from '../src/engine.js';
import { ErrorCodes } from '../src/errors.js';

const strip = (r) => {
  const { trace, ...rest } = r;
  return rest;
};

// Two disjoint cycles in different currencies:
//   USD cycle: A -> B -> C -> A (10 USD each)
//   EUR cycle: D -> E -> F -> D (10 EUR each)
const ratesV1 = {
  base: 'USD',
  versions: [{ version: 1, rates: { EUR: '1.0', GBP: '1.0' } }],
};
const trades = [
  { id: 'u1', from: 'A', to: 'B', currency: 'USD', amount: '10' },
  { id: 'u2', from: 'B', to: 'C', currency: 'USD', amount: '10' },
  { id: 'u3', from: 'C', to: 'A', currency: 'USD', amount: '10' },
  { id: 'e1', from: 'D', to: 'E', currency: 'EUR', amount: '10' },
  { id: 'e2', from: 'E', to: 'F', currency: 'EUR', amount: '10' },
  { id: 'e3', from: 'F', to: 'D', currency: 'EUR', amount: '10' },
];

test('rate correction recomputes only the affected netting cycle', () => {
  const e = new NettingEngine({ rates: ratesV1 });
  e.addTrades(trades);
  const before = e.settle();
  assert.equal(before.trace.components.length, 2);
  assert.ok(before.trace.components.every((c) => c.recomputed));

  const newVersion = e.correctRate('EUR', '2.0');
  assert.equal(newVersion, 2);
  const after = e.settle();

  // Only the EUR cycle's component is recomputed; the USD cycle is reused.
  const usdComp = after.trace.components.find((c) => c.parties.includes('A'));
  const eurComp = after.trace.components.find((c) => c.parties.includes('D'));
  assert.equal(usdComp.recomputed, false);
  assert.equal(eurComp.recomputed, true);
  assert.deepEqual(after.trace.affected.currencies, ['EUR']);
  assert.deepEqual(after.trace.affected.parties, ['D', 'E', 'F']);
  assert.equal(after.trace.cache.hits, 1);
  assert.equal(after.trace.cache.misses, 1);

  // USD cycle parties are untouched by the correction.
  for (const p of ['A', 'B', 'C']) {
    assert.deepEqual(
      after.netPositions.find((x) => x.party === p),
      before.netPositions.find((x) => x.party === p),
    );
    assert.deepEqual(
      after.locks.find((x) => x.party === p),
      before.locks.find((x) => x.party === p),
    );
  }
  assert.equal(after.proof.ratesVersion, 2);

  // Incremental result equals a fresh full recomputation at version 2.
  const fresh = new NettingEngine({
    rates: {
      base: 'USD',
      versions: [
        { version: 1, rates: { EUR: '1.0', GBP: '1.0' } },
        { version: 2, rates: { EUR: '2.0' } },
      ],
    },
  });
  fresh.addTrades(trades);
  assert.deepEqual(strip(after), strip(fresh.settle()));
});

test('voiding a trade releases frozen capacity and the release replays exactly', () => {
  const e = new NettingEngine({
    rates: ratesV1,
    limits: { A: '1000', B: '1000' },
  });
  e.addTrades([
    { id: 't1', from: 'A', to: 'B', currency: 'USD', amount: '100' },
    { id: 't2', from: 'B', to: 'A', currency: 'USD', amount: '40' },
  ]);
  const s1 = e.settle();
  assert.equal(s1.locks.find((l) => l.party === 'A').locked, '60');
  assert.equal(s1.locks.find((l) => l.party === 'B').locked, '0');

  e.voidTrade('t1');
  const s2 = e.settle();
  // Frozen capacity released: A locks nothing, B now owes 40.
  assert.equal(s2.locks.find((l) => l.party === 'A').locked, '0');
  assert.equal(s2.locks.find((l) => l.party === 'A').available, '1000');
  assert.equal(s2.locks.find((l) => l.party === 'B').locked, '40');

  // Replay from the journal reproduces the identical state.
  const replayed = e.replay().settle();
  assert.deepEqual(strip(replayed), strip(s2));
  assert.equal(replayed.proof.inputHash, s2.proof.inputHash);
});

test('voiding twice or voiding an unknown trade is NEGATIVE_RELEASE', () => {
  const e = new NettingEngine({ rates: ratesV1 });
  e.addTrades([{ id: 't1', from: 'A', to: 'B', currency: 'USD', amount: '10' }]);
  e.settle();
  e.voidTrade('t1');
  assert.throws(
    () => e.voidTrade('t1'),
    (err) => err.code === ErrorCodes.NEGATIVE_RELEASE && err.details.tradeId === 't1',
  );
  assert.throws(
    () => e.voidTrade('nope'),
    (err) => err.code === ErrorCodes.NEGATIVE_RELEASE,
  );
});

test('replay after rate correction reproduces identical state', () => {
  const e = new NettingEngine({ rates: ratesV1, limits: { A: '100', B: '100', C: '100', D: '100', E: '100', F: '100' } });
  e.addTrades(trades);
  e.settle();
  e.correctRate('EUR', '2.0');
  e.voidTrade('e1');
  const current = e.settle();
  const replayed = e.replay().settle();
  assert.deepEqual(strip(replayed), strip(current));
});

test('voiding can unblock a CYCLE_LOCKED cycle by releasing capacity', () => {
  // Cycle A->B->C->A of 50 plus an extra A->B trade of 40 that eats A's limit.
  const e = new NettingEngine({
    rates: ratesV1,
    limits: { A: '50', B: '50', C: '50' },
  });
  e.addTrades([
    { id: 'x1', from: 'A', to: 'B', currency: 'USD', amount: '50' },
    { id: 'x2', from: 'B', to: 'C', currency: 'USD', amount: '50' },
    { id: 'x3', from: 'C', to: 'A', currency: 'USD', amount: '50' },
    { id: 'x4', from: 'A', to: 'D', currency: 'USD', amount: '40' },
  ]);
  // Cycle bottleneck is 50 == limits, so it nets; then A owes 40 to D. OK.
  const ok = e.settle();
  assert.equal(ok.locks.find((l) => l.party === 'A').locked, '40');

  // Tighten the scenario: remove D's trade, lower B's limit -> locked cycle.
  const e2 = new NettingEngine({
    rates: ratesV1,
    limits: { A: '50', B: '49', C: '50' },
  });
  e2.addTrades([
    { id: 'x1', from: 'A', to: 'B', currency: 'USD', amount: '50' },
    { id: 'x2', from: 'B', to: 'C', currency: 'USD', amount: '50' },
    { id: 'x3', from: 'C', to: 'A', currency: 'USD', amount: '50' },
    { id: 'x4', from: 'B', to: 'D', currency: 'USD', amount: '1' },
  ]);
  assert.throws(() => e2.settle(), (err) => err.code === ErrorCodes.CYCLE_LOCKED);
  // Voiding x4 does not help (cycle itself is locked), but voiding a cycle
  // trade dissolves the cycle entirely and releases the frozen capacity.
  e2.voidTrade('x2');
  const r = e2.settle();
  assert.equal(r.ok, true);
  assert.equal(r.locks.find((l) => l.party === 'B').locked, '1');
});
