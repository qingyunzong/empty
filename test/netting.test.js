import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NettingEngine, RULES_VERSION } from '../src/engine.js';
import { NettingError, ErrorCodes } from '../src/errors.js';

const ratesDoc = {
  base: 'USD',
  versions: [
    { version: 1, rates: { EUR: '1.10', GBP: '1.25' } },
    { version: 2, rates: { EUR: '1.20' } },
  ],
};

function engineWith(trades, opts = {}) {
  const e = new NettingEngine({
    rates: ratesDoc,
    limits: opts.limits ?? null,
    windowCapacity: opts.windowCapacity ?? null,
  });
  e.addTrades(trades);
  return e;
}

test('bilateral offset nets opposing obligations', () => {
  const e = engineWith([
    { id: 't1', from: 'A', to: 'B', currency: 'USD', amount: '100' },
    { id: 't2', from: 'B', to: 'A', currency: 'USD', amount: '40' },
  ]);
  const r = e.settle();
  assert.deepEqual(r.netObligations, [{ from: 'A', to: 'B', amount: '60', trades: ['t1', 't2'] }]);
  assert.equal(r.netPositions.find((p) => p.party === 'A').net, '-60');
  assert.equal(r.netPositions.find((p) => p.party === 'B').net, '60');
});

test('multi-currency cycle is fully netted through FX conversion', () => {
  // A->B 100 USD, B->C 50 EUR (=60 USD at v2), C->A 48 GBP (=60 USD)
  const e = engineWith([
    { id: 't1', from: 'A', to: 'B', currency: 'USD', amount: '100' },
    { id: 't2', from: 'B', to: 'C', currency: 'EUR', amount: '50' },
    { id: 't3', from: 'C', to: 'A', currency: 'GBP', amount: '48' },
  ]);
  const r = e.settle();
  assert.deepEqual(r.netObligations, [{ from: 'A', to: 'B', amount: '40', trades: ['t1', 't2', 't3'] }]);
  assert.equal(r.trace.components.length, 1);
  assert.equal(r.trace.components[0].cycles, 1);
  assert.equal(r.window.used, '40');
});

test('pending cycle is solved, not reported unsatisfiable, when capacity suffices', () => {
  const e = engineWith(
    [
      { id: 't1', from: 'A', to: 'B', currency: 'USD', amount: '50' },
      { id: 't2', from: 'B', to: 'C', currency: 'USD', amount: '50' },
      { id: 't3', from: 'C', to: 'A', currency: 'USD', amount: '50' },
    ],
    { limits: { A: '50', B: '50', C: '50' } }, // bottleneck == limit exactly
  );
  const r = e.settle();
  assert.equal(r.ok, true);
  assert.deepEqual(r.netObligations, []);
  assert.ok(r.locks.every((l) => l.locked === '0'));
});

test('CYCLE_LOCKED reports minimal conflict set when capacity is below bottleneck', () => {
  const e = engineWith(
    [
      { id: 't1', from: 'A', to: 'B', currency: 'USD', amount: '50' },
      { id: 't2', from: 'B', to: 'C', currency: 'USD', amount: '50' },
      { id: 't3', from: 'C', to: 'A', currency: 'USD', amount: '50' },
    ],
    { limits: { A: '50', B: '49', C: '50' } },
  );
  assert.throws(
    () => e.settle(),
    (err) => {
      assert.ok(err instanceof NettingError);
      assert.equal(err.code, ErrorCodes.CYCLE_LOCKED);
      assert.deepEqual(err.details.cycle, ['A', 'B', 'C']);
      assert.equal(err.details.bottleneck, '50');
      assert.deepEqual(err.details.conflict.parties, [
        { party: 'B', required: '50', available: '49' },
      ]);
      assert.deepEqual(err.details.conflict.trades, ['t1', 't2', 't3']);
      return true;
    },
  );
});

test('frozen limit boundary: exactly equal succeeds, one minor unit over fails', () => {
  const trades = [{ id: 't1', from: 'A', to: 'B', currency: 'USD', amount: '100' }];
  const ok = engineWith(trades, { limits: { A: '100' } }).settle();
  assert.equal(ok.locks.find((l) => l.party === 'A').available, '0');

  assert.throws(
    () => engineWith(trades, { limits: { A: '99.999999' } }).settle(),
    (err) => {
      assert.equal(err.code, ErrorCodes.LIMIT);
      assert.equal(err.details.scope, 'party');
      assert.equal(err.details.party, 'A');
      assert.equal(err.details.required, '100');
      assert.equal(err.details.available, '99.999999');
      return true;
    },
  );
});

test('clearing window boundary: exactly equal succeeds, one minor unit over fails', () => {
  const trades = [
    { id: 't1', from: 'A', to: 'B', currency: 'USD', amount: '60' },
    { id: 't2', from: 'C', to: 'D', currency: 'USD', amount: '50' },
  ];
  const ok = engineWith(trades, { windowCapacity: '110' }).settle();
  assert.equal(ok.window.used, '110');

  assert.throws(
    () => engineWith(trades, { windowCapacity: '109.999999' }).settle(),
    (err) => {
      assert.equal(err.code, ErrorCodes.LIMIT);
      assert.equal(err.details.scope, 'window');
      assert.equal(err.details.required, '110');
      assert.equal(err.details.available, '109.999999');
      return true;
    },
  );
});

test('party missing from limits map is treated as zero capacity', () => {
  const e = engineWith(
    [{ id: 't1', from: 'A', to: 'B', currency: 'USD', amount: '1' }],
    { limits: { B: '100' } },
  );
  assert.throws(() => e.settle(), (err) => err.code === ErrorCodes.LIMIT && err.details.party === 'A');
});

test('stale rates version is rejected with RATE_STALE', () => {
  const e = engineWith([{ id: 't1', from: 'A', to: 'B', currency: 'USD', amount: '1' }]);
  assert.throws(
    () => e.settle({ ratesVersion: 1 }),
    (err) => {
      assert.equal(err.code, ErrorCodes.RATE_STALE);
      assert.equal(err.details.requested, 1);
      assert.equal(err.details.current, 2);
      return true;
    },
  );
  assert.throws(() => e.settle({ ratesVersion: 99 }), (err) => err.code === ErrorCodes.RATE_STALE);
});

test('missing rate for a currency is rejected', () => {
  const e = engineWith([{ id: 't1', from: 'A', to: 'B', currency: 'JPY', amount: '1' }]);
  assert.throws(() => e.settle(), (err) => err.code === ErrorCodes.RATE_MISSING);
});

test('deterministic: shuffled input order yields byte-identical output', () => {
  const trades = [
    { id: 't1', from: 'A', to: 'B', currency: 'USD', amount: '100' },
    { id: 't2', from: 'B', to: 'C', currency: 'EUR', amount: '50' },
    { id: 't3', from: 'C', to: 'A', currency: 'GBP', amount: '48' },
    { id: 't4', from: 'C', to: 'B', currency: 'USD', amount: '10' },
    { id: 't5', from: 'A', to: 'C', currency: 'EUR', amount: '5' },
    { id: 't6', from: 'B', to: 'A', currency: 'GBP', amount: '8' },
  ];
  const shuffled = [...trades].reverse();
  const r1 = engineWith(trades, { limits: { A: '1000', B: '1000', C: '1000' } }).settle();
  const r2 = engineWith(shuffled, { limits: { C: '1000', A: '1000', B: '1000' } }).settle();
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));
});

test('proof carries input hash, rules version and rates version', () => {
  const r = engineWith([{ id: 't1', from: 'A', to: 'B', currency: 'USD', amount: '1' }]).settle();
  assert.match(r.proof.inputHash, /^[0-9a-f]{64}$/);
  assert.equal(r.proof.rulesVersion, RULES_VERSION);
  assert.equal(r.proof.ratesVersion, 2);
  assert.equal(r.proof.base, 'USD');

  // Same inputs -> same hash; different inputs -> different hash.
  const r2 = engineWith([{ id: 't1', from: 'A', to: 'B', currency: 'USD', amount: '1' }]).settle();
  assert.equal(r2.proof.inputHash, r.proof.inputHash);
  const r3 = engineWith([{ id: 't1', from: 'A', to: 'B', currency: 'USD', amount: '2' }]).settle();
  assert.notEqual(r3.proof.inputHash, r.proof.inputHash);
});

test('overlapping cycles (figure-eight) reduce deterministically', () => {
  // Two cycles sharing node C: A->B->C->A and C->D->E->C
  const trades = [
    { id: 't1', from: 'A', to: 'B', currency: 'USD', amount: '30' },
    { id: 't2', from: 'B', to: 'C', currency: 'USD', amount: '30' },
    { id: 't3', from: 'C', to: 'A', currency: 'USD', amount: '30' },
    { id: 't4', from: 'C', to: 'D', currency: 'USD', amount: '20' },
    { id: 't5', from: 'D', to: 'E', currency: 'USD', amount: '20' },
    { id: 't6', from: 'E', to: 'C', currency: 'USD', amount: '20' },
  ];
  const r1 = engineWith(trades).settle();
  assert.deepEqual(r1.netObligations, []);
  const r2 = engineWith([...trades].reverse()).settle();
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));
});
