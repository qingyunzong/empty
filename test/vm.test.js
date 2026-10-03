import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSource } from '../src/compiler.js';
import { VM, normalizeOrder } from '../src/vm.js';

function run(src, rawOrder) {
  const program = compileSource(src);
  const vm = new VM(program);
  const order = normalizeOrder(rawOrder, program);
  return vm.execute(order);
}

const TIERED = `
contract "T" {
  defaults { rate = 25bps floor = 1.00 CNY }
  rounding HALF_EVEN
  residual to TAIL
  fee = {
    tier on [0.00 CNY, 1000000.00 CNY) fee = rate min floor
    tier on [1000000.00 CNY, 5000000.00 CNY) fee = 15bps
    tier on [5000000.00 CNY, ) fee = 10bps max 5000.00 CNY
  }
}`;

test('bps rate applied to amount with floor', () => {
  const r = run(TIERED, { id: 'a', amount: '100.00' });
  assert.equal(r.totalFee, '1.00'); // 100 * 25bps = 0.25 -> floor 1.00
  assert.deepEqual(r.matchedTiers, [0]);
});

test('mid tier and cap tier', () => {
  assert.equal(run(TIERED, { id: 'b', amount: '2000000.00' }).totalFee, '3000.00');
  assert.equal(run(TIERED, { id: 'c', amount: '100000000.00' }).totalFee, '5000.00'); // capped
});

test('per-order override of share-class default parameter', () => {
  const r = run(TIERED, { id: 'd', amount: '10000.00', overrides: { rate: '10bps' } });
  assert.equal(r.totalFee, '10.00');
  const def = run(TIERED, { id: 'e', amount: '10000.00' });
  assert.equal(def.totalFee, '25.00');
});

test('override with wrong unit type raises E_TYPE', () => {
  const program = compileSource(TIERED);
  assert.throws(
    () => normalizeOrder({ id: 'x', amount: '1.00', overrides: { rate: '1.00 CNY' } }, program),
    /E_TYPE/
  );
});

test('override of unknown parameter raises E_TYPE', () => {
  const program = compileSource(TIERED);
  assert.throws(
    () => normalizeOrder({ id: 'x', amount: '1.00', overrides: { nope: '1bps' } }, program),
    /E_TYPE/
  );
});

test('three parallel tiers hit: cheapest wins, all ties listed', () => {
  const src = `
contract "Tie" {
  rounding HALF_UP
  residual to TAIL
  fee = {
    tier on [0.00 CNY, 100.00 CNY) fee = 1.00 CNY
    tier on [50.00 CNY, 200.00 CNY) fee = 1.00 CNY
    tier on [0.00 CNY, ) fee = 1.00 CNY
  }
}`;
  const r = run(src, { id: 't', amount: '75.00' });
  assert.deepEqual(r.matchedTiers, [0, 1, 2]);
  assert.deepEqual(r.ties, [0, 1, 2]);
  assert.equal(r.totalFee, '1.00');
  const selectStep = r.steps.find((s) => s.op === 'SELECT_MIN');
  assert.equal(selectStep.candidates.length, 3);
  assert.deepEqual(selectStep.ties, [0, 1, 2]);
});

test('parallel tiers with distinct fees: cheapest wins', () => {
  const src = `
contract "Tie2" {
  rounding HALF_UP
  residual to TAIL
  fee = {
    tier on [0.00 CNY, ) fee = 3.00 CNY
    tier on [0.00 CNY, ) fee = 1.00 CNY
    tier on [0.00 CNY, ) fee = 2.00 CNY
  }
}`;
  const r = run(src, { id: 't', amount: '10.00' });
  assert.equal(r.totalFee, '1.00');
  assert.deepEqual(r.ties, [1]);
});

test('no matching tier raises E_TIER', () => {
  const src = `
contract "Gap" {
  rounding HALF_UP
  residual to TAIL
  fee = { tier on [100.00 CNY, 200.00 CNY) fee = 1bps }
}`;
  assert.throws(() => run(src, { id: 'g', amount: '50.00' }), /E_TIER/);
});

test('negative redemption amount raises E_TIER', () => {
  const program = compileSource(TIERED);
  assert.throws(
    () => normalizeOrder({ id: 'r', type: 'redemption', amount: '-100.00' }, program),
    /E_TIER:.*negative redemption/
  );
});

test('zero shares raises E_TIER', () => {
  const program = compileSource(TIERED);
  assert.throws(() => normalizeOrder({ id: 'z', amount: '10.00', shares: '0' }, program), /E_TIER:.*zero shares/);
});

test('order amount exceeding money precision raises E_LEX', () => {
  const program = compileSource(TIERED);
  assert.throws(() => normalizeOrder({ id: 'p', amount: '1.12345' }, program), /E_LEX/);
});

test('reported total mismatch raises E_CONSERVE', () => {
  assert.throws(
    () => run(TIERED, { id: 'm', amount: '10000.00', expectedTotal: '24.99' }),
    /E_CONSERVE/
  );
  const ok = run(TIERED, { id: 'm', amount: '10000.00', expectedTotal: '25.00' });
  assert.equal(ok.totalFee, '25.00');
});

test('conservation identity holds: total + residual == exact fee', () => {
  const r = run(TIERED, { id: 'k', amount: '12345.6789' });
  const step = r.steps.find((s) => s.op === 'CONSERVE');
  assert.equal(step.identityHolds, true);
  assert.equal(r.residualAccount, 'TAIL');
});

test('rounding step records remainder for every order', () => {
  const r = run(TIERED, { id: 'k', amount: '333.3333' });
  const round = r.steps.find((s) => s.op === 'ROUND');
  assert.equal(round.mode, 'HALF_EVEN');
  assert.ok('remainder' in round);
});
