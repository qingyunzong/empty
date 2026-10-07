'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  solveHistory,
  InputError,
  _prepare,
  _chooseCommitSequence,
} = require('../lib/solver');
const { bruteForceCommitSequence } = require('../lib/reference');

function byId(result, id) {
  return result.requests.find((r) => r.id === id);
}

test('acceptance 1: out-of-order refund and unfreeze are reordered around void', () => {
  const result = solveHistory({
    orders: [{ orderId: 'o1', charged: 1000, frozen: 500 }],
    requests: [
      { id: 'u1', type: 'unfreeze', orderId: 'o1', amount: 500, key: 'k-u', arrival: 1 },
      { id: 'r1', type: 'refund', orderId: 'o1', amount: 300, key: 'k-r', arrival: 2 },
      { id: 'v1', type: 'void', orderId: 'o1', key: 'k-v', arrival: 3 },
    ],
  });
  assert.equal(result.status, 'OK');
  assert.deepEqual(result.commitOrder, ['r1', 'v1', 'u1']);
  assert.equal(byId(result, 'u1').status, 'COMMITTED');
  assert.equal(byId(result, 'r1').status, 'COMMITTED');
  assert.equal(byId(result, 'v1').status, 'COMMITTED');
  assert.deepEqual(
    result.balances.map((b) => [b.requestId, b.refundable, b.frozenRemaining, b.voided]),
    [
      ['r1', 700, 500, false],
      ['v1', 700, 500, true],
      ['u1', 700, 0, true],
    ],
  );
});

test('acceptance 2: void intercepts a pending refund', () => {
  const result = solveHistory({
    orders: [{ orderId: 'o1', charged: 100 }],
    requests: [
      { id: 'r1', type: 'refund', orderId: 'o1', amount: 80, arrival: 1 },
      { id: 'r2', type: 'refund', orderId: 'o1', amount: 50, arrival: 2 },
      { id: 'v1', type: 'void', orderId: 'o1', arrival: 3 },
    ],
  });
  assert.equal(result.status, 'OK');
  assert.deepEqual(result.commitOrder, ['r1', 'v1']);
  assert.equal(byId(result, 'r1').status, 'COMMITTED');
  assert.equal(byId(result, 'v1').status, 'COMMITTED');
  const r2 = byId(result, 'r2');
  assert.equal(r2.status, 'REJECTED');
  assert.match(r2.reason, /void/);
});

test('acceptance 2b: without void the same refund stays PENDING (budget), not UNSAT', () => {
  const result = solveHistory({
    orders: [{ orderId: 'o1', charged: 100 }],
    requests: [
      { id: 'r1', type: 'refund', orderId: 'o1', amount: 80, arrival: 1 },
      { id: 'r2', type: 'refund', orderId: 'o1', amount: 50, arrival: 2 },
    ],
  });
  assert.equal(result.status, 'OK');
  assert.deepEqual(result.commitOrder, ['r1']);
  const r2 = byId(result, 'r2');
  assert.equal(r2.status, 'PENDING');
  assert.match(r2.reason, /insufficient refundable balance/);
});

test('acceptance 3: refund exceeding the charged total is UNSAT', () => {
  const result = solveHistory({
    orders: [{ orderId: 'o1', charged: 100 }],
    requests: [{ id: 'r1', type: 'refund', orderId: 'o1', amount: 150, arrival: 1 }],
  });
  assert.equal(result.status, 'UNSAT');
  assert.equal(byId(result, 'r1').status, 'UNSAT');
  assert.deepEqual(result.commitOrder, []);
});

test('acceptance 4: duplicate idempotency key replays the same result', () => {
  const result = solveHistory({
    orders: [{ orderId: 'o1', charged: 100 }],
    requests: [
      { id: 'r1', type: 'refund', orderId: 'o1', amount: 40, key: 'k1', arrival: 1 },
      { id: 'r2', type: 'refund', orderId: 'o1', amount: 40, key: 'k1', arrival: 2 },
    ],
  });
  assert.equal(result.status, 'OK');
  assert.deepEqual(result.commitOrder, ['r1']);
  const first = byId(result, 'r1');
  const dup = byId(result, 'r2');
  assert.equal(first.status, 'COMMITTED');
  assert.equal(dup.status, first.status);
  assert.equal(dup.slot, first.slot);
  assert.equal(dup.replayOf, 'r1');
  assert.equal(result.balances.length, 1);
});

test('idempotent replay with mismatched payload is flagged but still replays', () => {
  const result = solveHistory({
    orders: [{ orderId: 'o1', charged: 100 }],
    requests: [
      { id: 'r1', type: 'refund', orderId: 'o1', amount: 40, key: 'k1', arrival: 1 },
      { id: 'r2', type: 'refund', orderId: 'o1', amount: 60, key: 'k1', arrival: 2 },
    ],
  });
  const dup = byId(result, 'r2');
  assert.equal(dup.status, 'COMMITTED');
  assert.equal(dup.replayOf, 'r1');
  assert.equal(dup.payloadMismatch, true);
  assert.equal(result.balances[0].refunded, 40);
});

test('unfreeze without a void stays PENDING awaiting void', () => {
  const result = solveHistory({
    orders: [{ orderId: 'o1', charged: 100, frozen: 50 }],
    requests: [{ id: 'u1', type: 'unfreeze', orderId: 'o1', amount: 50, arrival: 1 }],
  });
  assert.equal(result.status, 'OK');
  assert.deepEqual(result.commitOrder, []);
  const u1 = byId(result, 'u1');
  assert.equal(u1.status, 'PENDING');
  assert.match(u1.reason, /awaiting successful void/);
});

test('conflict cycle from explicit after edges is reported', () => {
  const result = solveHistory({
    orders: [{ orderId: 'o1', charged: 100 }],
    requests: [
      { id: 'a', type: 'refund', orderId: 'o1', amount: 10, arrival: 1, after: ['b'] },
      { id: 'b', type: 'refund', orderId: 'o1', amount: 10, arrival: 2, after: ['a'] },
      { id: 'c', type: 'refund', orderId: 'o1', amount: 10, arrival: 3 },
    ],
  });
  assert.equal(result.status, 'UNSAT');
  assert.ok(Array.isArray(result.conflictCycle));
  const cycleSet = new Set(result.conflictCycle);
  assert.ok(cycleSet.has('a') && cycleSet.has('b'));
  assert.equal(byId(result, 'a').status, 'UNSAT');
  assert.equal(byId(result, 'b').status, 'UNSAT');
  assert.equal(byId(result, 'c').status, 'COMMITTED');
  assert.deepEqual(result.commitOrder, ['c']);
});

test('natural cycle: void depending on its own unfreeze is unserializable', () => {
  const result = solveHistory({
    orders: [{ orderId: 'o1', charged: 100, frozen: 50 }],
    requests: [
      { id: 'u1', type: 'unfreeze', orderId: 'o1', amount: 50, arrival: 1 },
      { id: 'v1', type: 'void', orderId: 'o1', arrival: 2, after: ['u1'] },
    ],
  });
  assert.equal(result.status, 'UNSAT');
  const cycleSet = new Set(result.conflictCycle);
  assert.ok(cycleSet.has('u1') && cycleSet.has('v1'));
});

test('explicit after edge propagates ordering into commit slots', () => {
  const result = solveHistory({
    orders: [{ orderId: 'o1', charged: 100 }],
    requests: [
      { id: 'r1', type: 'refund', orderId: 'o1', amount: 10, arrival: 1, after: ['r2'] },
      { id: 'r2', type: 'refund', orderId: 'o1', amount: 10, arrival: 2 },
    ],
  });
  assert.equal(result.status, 'OK');
  assert.deepEqual(result.commitOrder, ['r2', 'r1']);
});

test('unknown order raises InputError', () => {
  assert.throws(
    () =>
      solveHistory({
        orders: [{ orderId: 'o1', charged: 100 }],
        requests: [{ id: 'r1', type: 'refund', orderId: 'nope', amount: 10 }],
      }),
    (err) => err instanceof InputError && /unknown order/.test(err.message),
  );
});

test('illegal amounts raise InputError', () => {
  for (const amount of [-5, 0, NaN, Infinity, '10', null]) {
    assert.throws(
      () =>
        solveHistory({
          orders: [{ orderId: 'o1', charged: 100 }],
          requests: [{ id: 'r1', type: 'refund', orderId: 'o1', amount }],
        }),
      (err) => err instanceof InputError && /illegal amount/.test(err.message),
      `amount ${String(amount)} should be rejected`,
    );
  }
});

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('reference: backtracking solver matches permutation enumeration for <=5 requests', () => {
  const rand = lcg(20261008);
  const types = ['refund', 'void', 'unfreeze'];
  for (let trial = 0; trial < 300; trial++) {
    const orderCount = 1 + Math.floor(rand() * 2);
    const orders = [];
    for (let i = 0; i < orderCount; i++) {
      orders.push({
        orderId: `o${i}`,
        charged: 50 + Math.floor(rand() * 100),
        frozen: Math.floor(rand() * 60),
      });
    }
    const reqCount = 1 + Math.floor(rand() * 5);
    const requests = [];
    for (let i = 0; i < reqCount; i++) {
      const type = types[Math.floor(rand() * types.length)];
      const req = {
        id: `r${i}`,
        type,
        orderId: orders[Math.floor(rand() * orderCount)].orderId,
        key: `k${i}`,
        arrival: i,
      };
      if (type !== 'void') req.amount = 10 * (1 + Math.floor(rand() * 15));
      if (i > 0 && rand() < 0.15) {
        req.after = [`r${Math.floor(rand() * i)}`];
      }
      requests.push(req);
    }
    const input = { orders, requests };
    const prep = _prepare(input);
    const expected = bruteForceCommitSequence(prep.candidates, prep.canonical, prep.orders, prep.edges);
    const actual = _chooseCommitSequence(prep.candidates, prep.canonical, prep.orders, prep.edges);
    assert.deepEqual(
      actual,
      expected,
      `trial ${trial} mismatch for input ${JSON.stringify(input)}`,
    );
    const solved = solveHistory(input);
    assert.deepEqual(
      solved.commitOrder,
      expected.map((idx) => prep.canonical[idx].id),
      `trial ${trial} commitOrder mismatch`,
    );
  }
});
