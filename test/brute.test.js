// Cross-checks the main checker against an independent full-permutation
// enumerator on all histories of <= 6 operations (fixed cases + seeded
// random generation, both model-consistent and adversarial responses).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLinearizability } from '../src/checker.js';
import { bruteForceCheck } from '../src/brute.js';
import { createInitialState, applyOp, cloneState } from '../src/model.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const INITIAL_BALANCE = 50;

function randomHistory(rand, n, consistent) {
  const ops = [];
  for (let i = 0; i < n; i++) {
    const invocationTime = Math.floor(rand() * 8);
    const responseTime = invocationTime + Math.floor(rand() * 4);
    const type = ['reserve', 'commit', 'cancel', 'read'][Math.floor(rand() * 4)];
    const op = {
      client: `c${1 + Math.floor(rand() * 3)}`,
      opId: `op${i}`,
      invocationTime,
      responseTime,
      type,
      account: `a${1 + Math.floor(rand() * 2)}`,
    };
    if (type === 'reserve') {
      op.amount = [0, 5, 10, 20, 60][Math.floor(rand() * 5)];
      op.reserveId = `r${Math.floor(rand() * 3)}`;
    } else if (type === 'commit' || type === 'cancel') {
      op.reserveId = `r${Math.floor(rand() * 4)}`; // may be unknown
    } else {
      op.balance = 0; // placeholder, filled below
      op.frozen = 0;
    }
    ops.push(op);
  }

  if (consistent) {
    // Pick a random permutation, simulate it with the model, and record the
    // responses the model actually produces. Guarantees linearizability
    // unless the random real-time constraints forbid the chosen order.
    const perm = ops.map((_, i) => i);
    for (let i = perm.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    const state = createInitialState(INITIAL_BALANCE);
    for (const idx of perm) {
      const op = ops[idx];
      const result = applyOp(state, op);
      if (op.type === 'read') {
        op.balance = result.balance;
        op.frozen = result.frozen;
      } else {
        op.status = result.ok ? 'ok' : 'fail';
      }
    }
  } else {
    // Adversarial: random responses, mostly non-linearizable.
    for (const op of ops) {
      if (op.type === 'read') {
        op.balance = [0, 30, 40, 50][Math.floor(rand() * 4)];
        op.frozen = [0, 10, 20][Math.floor(rand() * 3)];
      } else {
        op.status = rand() < 0.5 ? 'ok' : 'fail';
      }
    }
  }
  return ops;
}

test('main checker agrees with brute-force enumerator on <=6 ops (seeded random)', () => {
  const rand = mulberry32(20261003);
  let linearizableCount = 0;
  const CASES = 400;
  for (let k = 0; k < CASES; k++) {
    const n = 1 + Math.floor(rand() * 6); // 1..6 operations
    const consistent = rand() < 0.5;
    const history = randomHistory(rand, n, consistent);
    const main = checkLinearizability(history, { initialBalance: INITIAL_BALANCE });
    const brute = bruteForceCheck(history, { initialBalance: INITIAL_BALANCE });
    assert.equal(
      main.linearizable,
      brute.linearizable,
      `case ${k} mismatch (consistent=${consistent}): ${JSON.stringify(history)}`,
    );
    if (main.linearizable) {
      linearizableCount++;
      // The witness order must itself be accepted by the brute-force simulator.
      const byId = new Map(history.map((o) => [o.opId, o]));
      const reordered = main.order.map((id) => byId.get(id));
      const replay = bruteForceCheck(reordered, { initialBalance: INITIAL_BALANCE });
      assert.equal(replay.linearizable, true, `case ${k}: witness does not replay`);
    }
  }
  console.log(`cross-check: ${CASES} random histories, ${linearizableCount} linearizable, all agree`);
});

test('exhaustive small hand-built cases agree with brute force', () => {
  const cases = [
    // simple ok flow
    [
      { client: 'c1', opId: 'r', invocationTime: 0, responseTime: 1, type: 'reserve', account: 'a', amount: 10, reserveId: 'x', status: 'ok' },
      { client: 'c1', opId: 'c', invocationTime: 2, responseTime: 3, type: 'commit', account: 'a', reserveId: 'x', status: 'ok' },
    ],
    // cancel/commit race, both claim ok -> impossible
    [
      { client: 'c1', opId: 'r', invocationTime: 0, responseTime: 1, type: 'reserve', account: 'a', amount: 10, reserveId: 'x', status: 'ok' },
      { client: 'c2', opId: 'ca', invocationTime: 2, responseTime: 5, type: 'cancel', account: 'a', reserveId: 'x', status: 'ok' },
      { client: 'c3', opId: 'co', invocationTime: 3, responseTime: 6, type: 'commit', account: 'a', reserveId: 'x', status: 'ok' },
    ],
    // same race but commit fails -> fine
    [
      { client: 'c1', opId: 'r', invocationTime: 0, responseTime: 1, type: 'reserve', account: 'a', amount: 10, reserveId: 'x', status: 'ok' },
      { client: 'c2', opId: 'ca', invocationTime: 2, responseTime: 5, type: 'cancel', account: 'a', reserveId: 'x', status: 'ok' },
      { client: 'c3', opId: 'co', invocationTime: 3, responseTime: 6, type: 'commit', account: 'a', reserveId: 'x', status: 'fail' },
    ],
    // two reserves exceeding funds: second must fail
    [
      { client: 'c1', opId: 'r1', invocationTime: 0, responseTime: 1, type: 'reserve', account: 'a', amount: 40, reserveId: 'x', status: 'ok' },
      { client: 'c2', opId: 'r2', invocationTime: 2, responseTime: 3, type: 'reserve', account: 'a', amount: 40, reserveId: 'y', status: 'ok' },
    ],
    // duplicate reserveId reuse -> second reserve fails
    [
      { client: 'c1', opId: 'r1', invocationTime: 0, responseTime: 1, type: 'reserve', account: 'a', amount: 1, reserveId: 'x', status: 'ok' },
      { client: 'c2', opId: 'r2', invocationTime: 2, responseTime: 3, type: 'reserve', account: 'a', amount: 1, reserveId: 'x', status: 'ok' },
    ],
    // zero-amount reserve always succeeds even with zero balance
    [
      { client: 'c1', opId: 'r0', invocationTime: 0, responseTime: 1, type: 'reserve', account: 'a', amount: 0, reserveId: 'z', status: 'ok' },
      { client: 'c1', opId: 'rd', invocationTime: 2, responseTime: 3, type: 'read', account: 'a', balance: 0, frozen: 0 },
    ],
  ];
  for (const [i, history] of cases.entries()) {
    const main = checkLinearizability(history, { initialBalance: 50 });
    const brute = bruteForceCheck(history, { initialBalance: 50 });
    assert.equal(main.linearizable, brute.linearizable, `hand-built case ${i}`);
  }
});
