import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frac, eq } from '../src/fraction.js';
import { solve } from '../src/solver.js';
import { verify } from '../src/checker.js';
import { mulberry32, randomProblem, bruteForce } from './helpers.js';

function assertSameResult(problem, solved, brute) {
  assert.equal(solved.status, 'OK');
  assert.equal(solved.volume, brute.volume, 'volume mismatch');
  assert.ok(eq(solved.spend, brute.spend), 'spend mismatch');
  assert.equal(solved.count, brute.count, 'tie count mismatch');
  assert.deepEqual(solved.vector, brute.vector, 'lex-min vector mismatch');
}

test('cross-checks against brute force enumeration (orders<=8, qty<=3)', () => {
  // 300 small cases plus 60 cases at the acceptance boundary of 8 orders.
  for (let seed = 1; seed <= 300; seed++) {
    const rng = mulberry32(seed);
    const problem = randomProblem(rng, { maxOrders: 6, maxQty: 3 });
    const solved = solve(problem, { proof: false });
    const brute = bruteForce(problem);
    assertSameResult(problem, solved, brute);
  }
  for (let seed = 1000; seed < 1060; seed++) {
    const rng = mulberry32(seed);
    const problem = randomProblem(rng, { maxOrders: 8, maxQty: 3 });
    const solved = solve(problem, { proof: false });
    const brute = bruteForce(problem);
    assertSameResult(problem, solved, brute);
  }
});

test('solver is deterministic', () => {
  const rng = mulberry32(42);
  const problem = randomProblem(rng, { maxOrders: 8, maxQty: 3 });
  const a = solve(problem, { proof: false });
  const b = solve(problem, { proof: false });
  assert.deepEqual(a, b);
});

test('proof tree verifies, and independent checker confirms count', () => {
  for (let seed = 5000; seed < 5040; seed++) {
    const rng = mulberry32(seed);
    const problem = randomProblem(rng, { maxOrders: 5, maxQty: 2 });
    const solved = solve(problem, { proof: true });
    const checked = verify(problem, solved);
    assert.ok(checked.ok, `proof rejected at seed ${seed}: ${JSON.stringify(checked)}`);
    const brute = bruteForce(problem);
    assertSameResult(problem, solved, brute);
  }
});

test('checker rejects a tampered tie count', () => {
  const rng = mulberry32(777);
  const problem = randomProblem(rng, { maxOrders: 5, maxQty: 2 });
  const solved = solve(problem, { proof: true });
  assert.ok(verify(problem, solved).ok);
  const tampered = { ...solved, count: solved.count + 1n };
  const checked = verify(problem, tampered);
  assert.equal(checked.ok, false);
  assert.equal(checked.error, 'E_RESULT');
});

test('checker rejects a tampered split coverage', () => {
  // Find a case whose proof tree has an internal split node.
  function findInternal(node) {
    if (node.children && node.children.length > 1) return node;
    if (node.children) return findInternal(node.children[0]);
    return null;
  }
  let problem = null;
  let solved = null;
  let internal = null;
  for (let seed = 888; seed < 1000 && !internal; seed++) {
    const rng = mulberry32(seed);
    problem = randomProblem(rng, { maxOrders: 5, maxQty: 2 });
    solved = solve(problem, { proof: true });
    internal = findInternal(solved.proof);
  }
  assert.ok(verify(problem, solved).ok);
  assert.ok(internal, 'expected an internal node');
  internal.children[0] = {
    ...internal.children[0],
    fix: { ...internal.children[0].fix, value: internal.children[0].fix.value + 1n },
  };
  const checked = verify(problem, solved);
  assert.equal(checked.ok, false);
  assert.match(checked.error, /E_SPLIT|E_BOUNDS|E_PRUNE|E_LEAF/);
});

test('budget exhaustion is never reported as zero fills', () => {
  const problem = {
    orders: [
      { id: 'B1', account: 'A', side: 'buy', instrument: 'X', qty: 3n, limit: frac(5n) },
      { id: 'B2', account: 'A', side: 'buy', instrument: 'X', qty: 3n, limit: frac(5n) },
      { id: 'S1', account: 'C', side: 'sell', instrument: 'X', qty: 3n, limit: frac(1n) },
      { id: 'S2', account: 'C', side: 'sell', instrument: 'X', qty: 3n, limit: frac(1n) },
    ],
    prices: { X: frac(2n) },
    funds: { A: frac(100n), C: frac(0n) },
  };
  const full = solve(problem, { proof: false });
  assert.equal(full.volume, 6n); // the real optimum is nonzero
  const starved = solve(problem, { budget: 2, proof: false });
  assert.equal(starved.status, 'E_BUDGET');
  assert.notEqual(starved.status, 'OK');
  assert.equal(starved.volume, undefined, 'no zero-fill result may be fabricated');
});

test('exact budget boundary is feasible', () => {
  const problem = {
    orders: [
      { id: 'B1', account: 'A', side: 'buy', instrument: 'X', qty: 2n, limit: frac(3n, 2n) },
      { id: 'S1', account: 'C', side: 'sell', instrument: 'X', qty: 2n, limit: frac(1n) },
    ],
    prices: { X: frac(3n, 2n) },
    funds: { A: frac(3n), C: frac(0n) }, // exactly 2 * 3/2
  };
  const solved = solve(problem, { proof: true });
  assert.equal(solved.volume, 2n);
  assert.ok(eq(solved.spend, frac(3n)));
  assert.equal(solved.count, 1n);
  assert.ok(verify(problem, solved).ok);
  // One unit less of funds: only one unit can clear.
  const tighter = solve(
    { ...problem, funds: { A: frac(5n, 2n), C: frac(0n) } },
    { proof: false },
  );
  assert.equal(tighter.volume, 1n);
});

test('cross-instrument shared account funds couple the windows', () => {
  // One buyer account with funds 5 shared across two instruments priced 1.
  const problem = {
    orders: [
      { id: 'O1', account: 'A', side: 'buy', instrument: 'X', qty: 3n, limit: frac(2n) },
      { id: 'O2', account: 'A', side: 'buy', instrument: 'Y', qty: 3n, limit: frac(2n) },
      { id: 'O3', account: 'B', side: 'sell', instrument: 'X', qty: 3n, limit: frac(1n) },
      { id: 'O4', account: 'C', side: 'sell', instrument: 'Y', qty: 3n, limit: frac(1n) },
    ],
    prices: { X: frac(1n), Y: frac(1n) },
    funds: { A: frac(5n), B: frac(0n), C: frac(0n) },
  };
  const solved = solve(problem, { proof: true });
  assert.equal(solved.volume, 5n);
  assert.ok(eq(solved.spend, frac(5n)));
  assert.equal(solved.count, 2n); // (2,3) and (3,3)->(3,2): splits of 5 into <=3 parts
  assert.deepEqual(solved.vector, { O1: 2n, O2: 3n, O3: 2n, O4: 3n });
  assert.ok(verify(problem, solved).ok);
});

test('huge fractions compare exactly against brute force', () => {
  const big = 10n ** 30n;
  const problem = {
    orders: [
      {
        id: 'B1',
        account: 'A',
        side: 'buy',
        instrument: 'X',
        qty: 3n,
        limit: frac(big + 7n, big - 3n),
      },
      {
        id: 'B2',
        account: 'A2',
        side: 'buy',
        instrument: 'Y',
        qty: 2n,
        limit: frac(2n * big + 1n, big),
      },
      {
        id: 'S1',
        account: 'C',
        side: 'sell',
        instrument: 'X',
        qty: 3n,
        limit: frac(big, big + 1n),
      },
      {
        id: 'S2',
        account: 'C2',
        side: 'sell',
        instrument: 'Y',
        qty: 2n,
        limit: frac(big, big - 1n),
      },
    ],
    prices: {
      X: frac(big + 1n, big - 1n),
      Y: frac(2n * big - 3n, big + 11n),
    },
    funds: {
      A: frac(3n * big + 5n, big - 2n),
      A2: frac(5n * big + 1n, big),
      C: frac(0n),
      C2: frac(0n),
    },
  };
  const solved = solve(problem, { proof: true });
  const brute = bruteForce(problem);
  assertSameResult(problem, solved, brute);
  assert.ok(verify(problem, solved).ok);
});

test('limit prices gate participation', () => {
  const problem = {
    orders: [
      { id: 'B1', account: 'A', side: 'buy', instrument: 'X', qty: 2n, limit: frac(1n) }, // too low
      { id: 'B2', account: 'A', side: 'buy', instrument: 'X', qty: 2n, limit: frac(3n) },
      { id: 'S1', account: 'C', side: 'sell', instrument: 'X', qty: 2n, limit: frac(4n) }, // too high
      { id: 'S2', account: 'C', side: 'sell', instrument: 'X', qty: 2n, limit: frac(2n) },
    ],
    prices: { X: frac(2n) },
    funds: { A: frac(100n), C: frac(0n) },
  };
  const solved = solve(problem, { proof: false });
  assert.equal(solved.volume, 2n);
  assert.deepEqual(solved.vector, { B1: 0n, B2: 2n, S1: 0n, S2: 2n });
});
