import test from 'node:test';
import assert from 'node:assert/strict';
import { solveProblem, BudgetExceeded } from '../src/solver.js';
import { verifyProof } from '../src/checker.js';
import { enumerateAll } from '../src/brute.js';
import { frac } from '../src/fraction.js';

const f = (n, d = 1n) => frac(BigInt(n), BigInt(d));

test('simple match maximizes quantity then minimizes spend', () => {
  const orders = [
    { id: 'b1', account: 'A', side: 'buy', symbol: 'X', cap: 2n, price: f(4) },
    { id: 's1', account: 'B', side: 'sell', symbol: 'X', cap: 2n, price: f(4) },
  ];
  const funds = new Map([['A', f(100)]]);
  const r = solveProblem(orders, funds);
  assert.equal(r.qty, 2n);
  assert.deepEqual(r.spend, f(8));
  assert.equal(r.count, 1n);
  assert.deepEqual(r.vector, [2n, 2n]);
  const check = verifyProof(orders, funds, r.proof, r);
  assert.deepEqual(check.errors, []);
  assert.ok(check.ok);
});

test('shared account funds bind across symbols', () => {
  // One buyer account with funds 9, two symbols priced 3 each, caps 2.
  const orders = [
    { id: 'b1', account: 'A', side: 'buy', symbol: 'X', cap: 2n, price: f(3) },
    { id: 'b2', account: 'A', side: 'buy', symbol: 'Y', cap: 2n, price: f(3) },
    { id: 's1', account: 'B', side: 'sell', symbol: 'X', cap: 2n, price: f(3) },
    { id: 's2', account: 'C', side: 'sell', symbol: 'Y', cap: 2n, price: f(3) },
  ];
  const funds = new Map([['A', f(9)]]);
  const r = solveProblem(orders, funds);
  assert.equal(r.qty, 3n); // 4 units would cost 12 > 9
  assert.deepEqual(r.spend, f(9));
  assert.equal(r.count, 2n); // (1,2) or (2,1) across symbols
  assert.deepEqual(r.vector, [1n, 2n, 1n, 2n]); // lexicographically smallest
  const check = verifyProof(orders, funds, r.proof, r);
  assert.ok(check.ok, check.errors.join('; '));
  const brute = enumerateAll(orders, funds);
  assert.equal(brute.count, r.count);
  assert.deepEqual(brute.vector, r.vector);
});

test('tie counting and lexicographically smallest vector', () => {
  // Funds allow exactly one unit; 2 buys x 2 sells => 4 tied vectors.
  const orders = [
    { id: 'b1', account: 'A', side: 'buy', symbol: 'X', cap: 1n, price: f(1) },
    { id: 'b2', account: 'A', side: 'buy', symbol: 'X', cap: 1n, price: f(1) },
    { id: 's1', account: 'B', side: 'sell', symbol: 'X', cap: 1n, price: f(1) },
    { id: 's2', account: 'B', side: 'sell', symbol: 'X', cap: 1n, price: f(1) },
  ];
  const funds = new Map([['A', f(1)]]);
  const r = solveProblem(orders, funds);
  assert.equal(r.qty, 1n);
  assert.equal(r.count, 4n);
  assert.deepEqual(r.vector, [0n, 1n, 0n, 1n]);
  const check = verifyProof(orders, funds, r.proof, r);
  assert.ok(check.ok, check.errors.join('; '));
});

test('checker rejects tampered tie count, vector and qty', () => {
  const orders = [
    { id: 'b1', account: 'A', side: 'buy', symbol: 'X', cap: 1n, price: f(1) },
    { id: 'b2', account: 'A', side: 'buy', symbol: 'X', cap: 1n, price: f(1) },
    { id: 's1', account: 'B', side: 'sell', symbol: 'X', cap: 1n, price: f(1) },
    { id: 's2', account: 'B', side: 'sell', symbol: 'X', cap: 1n, price: f(1) },
  ];
  const funds = new Map([['A', f(1)]]);
  const r = solveProblem(orders, funds);
  const bad1 = verifyProof(orders, funds, r.proof, { ...r, count: 3n });
  assert.ok(!bad1.ok);
  assert.match(bad1.errors.join(' '), /count mismatch/);
  const bad2 = verifyProof(orders, funds, r.proof, { ...r, vector: [1n, 0n, 0n, 1n] });
  assert.ok(!bad2.ok);
  const bad3 = verifyProof(orders, funds, r.proof, { ...r, qty: 2n });
  assert.ok(!bad3.ok);
  const bad4 = verifyProof(orders, funds, r.proof, { ...r, spend: f(2) });
  assert.ok(!bad4.ok);
});

test('budget exhaustion raises E_BUDGET, never a fake zero fill', () => {
  const orders = [];
  for (let i = 0; i < 4; i++) {
    orders.push({ id: `b${i}`, account: 'A', side: 'buy', symbol: 'X', cap: 3n, price: f(1) });
    orders.push({ id: `s${i}`, account: 'B', side: 'sell', symbol: 'X', cap: 3n, price: f(1) });
  }
  assert.throws(() => solveProblem(orders, new Map([['A', f(1000)]]), 10), BudgetExceeded);
  // With enough budget the same instance solves to a nonzero optimum.
  const r = solveProblem(orders, new Map([['A', f(1000)]]));
  assert.equal(r.qty, 12n);
});

test('exact budget boundary with huge fractions', () => {
  const p = f(123456789123456789123456789n, 987654321987654321n);
  const orders = [
    { id: 'b1', account: 'A', side: 'buy', symbol: 'X', cap: 3n, price: p },
    { id: 's1', account: 'B', side: 'sell', symbol: 'X', cap: 3n, price: p },
  ];
  const twoP = { num: p.num * 2n, den: p.den };
  const exact = solveProblem(orders, new Map([['A', twoP]]));
  assert.equal(exact.qty, 2n); // exactly affordable
  const oneShort = solveProblem(orders, new Map([['A', { num: p.num * 2n - 1n, den: p.den }]]));
  assert.equal(oneShort.qty, 1n); // one unit below the boundary
});
