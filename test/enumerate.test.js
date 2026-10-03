import test from 'node:test';
import assert from 'node:assert/strict';
import { solveProblem } from '../src/solver.js';
import { verifyProof } from '../src/checker.js';
import { enumerateAll } from '../src/brute.js';
import { frac, cmp } from '../src/fraction.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('solver matches exhaustive enumeration on small instances (<=8 orders, qty<=3)', () => {
  const rand = rng(20261004);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  for (let tc = 0; tc < 25; tc++) {
    const nSymbols = 1 + Math.floor(rand() * 2);
    const symbols = Array.from({ length: nSymbols }, (_, i) => `S${i}`);
    const accounts = ['A', 'B', 'C'];
    const nOrders = 1 + Math.floor(rand() * 8);
    const orders = [];
    const funds = new Map();
    for (const a of accounts) funds.set(a, frac(BigInt(Math.floor(rand() * 11)), BigInt(1 + Math.floor(rand() * 2))));
    for (let i = 0; i < nOrders; i++) {
      orders.push({
        id: `o${i}`,
        account: pick(accounts),
        side: rand() < 0.5 ? 'buy' : 'sell',
        symbol: pick(symbols),
        cap: BigInt(Math.floor(rand() * 4)),
        price: frac(BigInt(1 + Math.floor(rand() * 5)), BigInt(1 + Math.floor(rand() * 3))),
      });
    }
    const solved = solveProblem(orders, funds);
    const brute = enumerateAll(orders, funds);
    assert.equal(solved.qty, brute.qty, `case ${tc} qty`);
    assert.equal(cmp(solved.spend, brute.spend), 0, `case ${tc} spend`);
    assert.equal(solved.count, brute.count, `case ${tc} tie count`);
    assert.deepEqual(solved.vector, brute.vector, `case ${tc} lex-min vector`);
    // Determinism: identical repeat run.
    const again = solveProblem(orders, funds);
    assert.deepEqual(
      { qty: again.qty, spend: again.spend, count: again.count, vector: again.vector },
      { qty: solved.qty, spend: solved.spend, count: solved.count, vector: solved.vector },
      `case ${tc} determinism`,
    );
    // Independent checker validates split coverage and optimal count.
    const check = verifyProof(orders, funds, solved.proof, solved);
    assert.ok(check.ok, `case ${tc} proof: ${check.errors.join('; ')}`);
  }
});
