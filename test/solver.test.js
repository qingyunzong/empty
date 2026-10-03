'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main: cliMain } = require('../index');

const {
  solveHistory,
  normalizeInput,
  dedupeRequests,
  resolveDependencies,
  solveGreedy,
  referenceVerify,
  InputError,
} = require('../lib/solver');

const ROOT = path.join(__dirname, '..');

function solve(input) {
  return solveHistory(input);
}

test('acceptance 1: out-of-order refund and unfreeze are ordered correctly', () => {
  const result = solve({
    orders: [{ orderId: 'o1', charged: 100 }],
    requests: [
      { requestId: 'u1', idempotencyKey: 'k-u', type: 'UNFREEZE', orderId: 'o1', arrivalSeq: 1 },
      { requestId: 'r1', idempotencyKey: 'k-r', type: 'REFUND', orderId: 'o1', amount: 30, arrivalSeq: 2 },
      { requestId: 'c1', idempotencyKey: 'k-c', type: 'CANCEL', orderId: 'o1', arrivalSeq: 3 },
    ],
  });
  assert.equal(result.status, 'OK');
  assert.deepEqual(result.commitOrder, ['r1', 'c1', 'u1']);
  assert.deepEqual(result.slots, { r1: 1, c1: 2, u1: 3 });
  const trajectory = result.balanceTrajectory;
  assert.equal(trajectory[0].balance, 70);
  assert.equal(trajectory[2].unfrozen, true);
  const order = result.orders[0];
  assert.equal(order.balance, 70);
  assert.equal(order.cancelled, true);
  assert.equal(order.unfrozen, true);
  assert.ok(result.requests.every((r) => r.status === 'COMMITTED'));
});

test('acceptance 2: cancel intercepts a waiting refund', () => {
  const result = solve({
    orders: [{ orderId: 'o1', charged: 100 }],
    requests: [
      { requestId: 'c1', idempotencyKey: 'k-c', type: 'CANCEL', orderId: 'o1', arrivalSeq: 1 },
      { requestId: 'r1', idempotencyKey: 'k-r', type: 'REFUND', orderId: 'o1', amount: 40, arrivalSeq: 2 },
    ],
  });
  assert.equal(result.status, 'PENDING');
  assert.deepEqual(result.commitOrder, ['c1']);
  const refund = result.requests.find((r) => r.requestId === 'r1');
  assert.equal(refund.status, 'PENDING');
  assert.equal(refund.slot, null);
  assert.equal(result.orders[0].balance, 100);
  assert.equal(result.orders[0].cancelled, true);
});

test('acceptance 3: refund exceeding charged amount is UNSAT', () => {
  const result = solve({
    orders: [{ orderId: 'o1', charged: 100 }],
    requests: [
      { requestId: 'r1', idempotencyKey: 'k-r', type: 'REFUND', orderId: 'o1', amount: 150, arrivalSeq: 1 },
    ],
  });
  assert.equal(result.status, 'UNSAT');
  assert.deepEqual(result.conflictCycle, ['r1']);
  assert.match(result.reason, /exceeds charged/);
  assert.equal(result.requests[0].status, 'REJECTED');
});

test('acceptance 4: duplicate idempotency key replays the same result', () => {
  const result = solve({
    orders: [{ orderId: 'o1', charged: 100 }],
    requests: [
      { requestId: 'r1', idempotencyKey: 'k-dup', type: 'REFUND', orderId: 'o1', amount: 30, arrivalSeq: 1 },
      { requestId: 'r2', idempotencyKey: 'k-dup', type: 'REFUND', orderId: 'o1', amount: 30, arrivalSeq: 2 },
    ],
  });
  assert.equal(result.status, 'OK');
  assert.deepEqual(result.commitOrder, ['r1']);
  const replay = result.requests.find((r) => r.requestId === 'r2');
  assert.equal(replay.status, 'REPLAY');
  assert.equal(replay.replayOf, 'r1');
  assert.equal(replay.slot, 1);
  assert.equal(result.orders[0].refunded, 30);
  assert.equal(result.orders[0].balance, 70);
});

test('budget insufficiency yields PENDING, not UNSAT', () => {
  const result = solve({
    orders: [{ orderId: 'o1', charged: 100 }],
    requests: [
      { requestId: 'r1', idempotencyKey: 'k1', type: 'REFUND', orderId: 'o1', amount: 60, arrivalSeq: 1 },
      { requestId: 'r2', idempotencyKey: 'k2', type: 'REFUND', orderId: 'o1', amount: 60, arrivalSeq: 2 },
    ],
  });
  assert.equal(result.status, 'PENDING');
  assert.deepEqual(result.commitOrder, ['r1']);
  assert.equal(result.requests.find((r) => r.requestId === 'r2').status, 'PENDING');
  assert.equal(result.orders[0].balance, 40);
});

test('unfreeze without any cancel is UNSAT', () => {
  const result = solve({
    orders: [{ orderId: 'o1', charged: 100 }],
    requests: [
      { requestId: 'u1', idempotencyKey: 'k-u', type: 'UNFREEZE', orderId: 'o1', arrivalSeq: 1 },
    ],
  });
  assert.equal(result.status, 'UNSAT');
  assert.deepEqual(result.conflictCycle, ['u1']);
});

test('dependency cycle is UNSAT and reports the conflict cycle', () => {
  const result = solve({
    orders: [{ orderId: 'o1', charged: 100 }],
    requests: [
      { requestId: 'c1', idempotencyKey: 'k-c', type: 'CANCEL', orderId: 'o1', arrivalSeq: 1, after: ['u1'] },
      { requestId: 'u1', idempotencyKey: 'k-u', type: 'UNFREEZE', orderId: 'o1', arrivalSeq: 2 },
    ],
  });
  assert.equal(result.status, 'UNSAT');
  assert.deepEqual(result.conflictCycle, ['c1', 'u1', 'c1']);
});

test('second cancel on the same order waits as PENDING', () => {
  const result = solve({
    orders: [{ orderId: 'o1', charged: 100 }],
    requests: [
      { requestId: 'c1', idempotencyKey: 'k1', type: 'CANCEL', orderId: 'o1', arrivalSeq: 1 },
      { requestId: 'c2', idempotencyKey: 'k2', type: 'CANCEL', orderId: 'o1', arrivalSeq: 2 },
    ],
  });
  assert.equal(result.status, 'PENDING');
  assert.deepEqual(result.commitOrder, ['c1']);
});

test('multi-order histories are independent', () => {
  const result = solve({
    orders: [
      { orderId: 'o1', charged: 100 },
      { orderId: 'o2', charged: 50 },
    ],
    requests: [
      { requestId: 'r1', idempotencyKey: 'k1', type: 'REFUND', orderId: 'o1', amount: 80, arrivalSeq: 1 },
      { requestId: 'r2', idempotencyKey: 'k2', type: 'REFUND', orderId: 'o2', amount: 40, arrivalSeq: 2 },
      { requestId: 'r3', idempotencyKey: 'k3', type: 'REFUND', orderId: 'o1', amount: 30, arrivalSeq: 3 },
    ],
  });
  assert.equal(result.status, 'PENDING');
  assert.deepEqual(result.commitOrder, ['r1', 'r2']);
  const o1 = result.orders.find((o) => o.orderId === 'o1');
  const o2 = result.orders.find((o) => o.orderId === 'o2');
  assert.equal(o1.balance, 20);
  assert.equal(o2.balance, 10);
});

test('invalid inputs raise InputError', () => {
  assert.throws(() => solve({
    orders: [{ orderId: 'o1', charged: 100 }],
    requests: [{ requestId: 'r1', type: 'REFUND', orderId: 'nope', amount: 10 }],
  }), InputError);
  assert.throws(() => solve({
    orders: [{ orderId: 'o1', charged: 100 }],
    requests: [{ requestId: 'r1', type: 'REFUND', orderId: 'o1', amount: 0 }],
  }), InputError);
  assert.throws(() => solve({
    orders: [{ orderId: 'o1', charged: 100 }],
    requests: [{ requestId: 'r1', type: 'REFUND', orderId: 'o1', amount: -5 }],
  }), InputError);
  assert.throws(() => solve({
    orders: [{ orderId: 'o1', charged: -1 }],
    requests: [],
  }), InputError);
});

// Reference cross-check: for every instance with <= 5 canonical requests the
// greedy commit sequence must agree with permutation enumeration.
function randomInstance(rng, requestCount) {
  const orderCount = 1 + Math.floor(rng() * 2);
  const orders = [];
  for (let i = 0; i < orderCount; i += 1) {
    orders.push({ orderId: `o${i}`, charged: 50 + Math.floor(rng() * 100) });
  }
  const types = ['REFUND', 'REFUND', 'CANCEL', 'UNFREEZE'];
  const requests = [];
  for (let i = 0; i < requestCount; i += 1) {
    const type = types[Math.floor(rng() * types.length)];
    const request = {
      requestId: `r${i}`,
      idempotencyKey: `k${i}`,
      type,
      orderId: orders[Math.floor(rng() * orders.length)].orderId,
      arrivalSeq: i,
    };
    if (type === 'REFUND') request.amount = 10 + Math.floor(rng() * 90);
    requests.push(request);
  }
  // Shuffle arrival order to simulate out-of-order arrival.
  for (let i = requests.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [requests[i], requests[j]] = [requests[j], requests[i]];
  }
  requests.forEach((request, index) => { request.arrivalSeq = index; });
  return { orders, requests };
}

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('reference: greedy matches permutation enumeration for <= 5 requests', () => {
  const rng = mulberry32(20261004);
  let checked = 0;
  for (let trial = 0; trial < 400; trial += 1) {
    const requestCount = 1 + Math.floor(rng() * 5);
    const input = randomInstance(rng, requestCount);
    const { orders, requests } = normalizeInput(input);
    const { canonical } = dedupeRequests(requests);
    const deps = resolveDependencies(canonical);
    const conflict = require('../lib/solver').findHardConflict(orders, canonical, deps);
    if (conflict) continue; // UNSAT instances have no commit sequence to compare
    const { committed } = solveGreedy(orders, canonical, deps);
    const verdict = referenceVerify(orders, canonical, deps, committed);
    assert.ok(verdict.ok, `trial ${trial}: ${verdict.detail} input=${JSON.stringify(input)}`);
    checked += 1;
  }
  assert.ok(checked > 200, `expected enough SAT instances, got ${checked}`);
});

function runCli(argv) {
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    return { code: cliMain(argv), stderr: errors.join('\n') };
  } finally {
    console.error = originalError;
  }
}

function writeInput(dir, input) {
  const inputPath = path.join(dir, 'input.json');
  fs.writeFileSync(inputPath, JSON.stringify(input));
  return inputPath;
}

test('CLI: history command writes output and exits 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'));
  const inputPath = writeInput(dir, {
    orders: [{ orderId: 'o1', charged: 100 }],
    requests: [
      { requestId: 'u1', idempotencyKey: 'k-u', type: 'UNFREEZE', orderId: 'o1', arrivalSeq: 1 },
      { requestId: 'c1', idempotencyKey: 'k-c', type: 'CANCEL', orderId: 'o1', arrivalSeq: 2 },
    ],
  });
  const outputPath = path.join(dir, 'output.json');
  const run = runCli(['history', inputPath, outputPath]);
  assert.equal(run.code, 0);
  const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(output.status, 'OK');
  assert.deepEqual(output.commitOrder, ['c1', 'u1']);
});

test('CLI: unknown order exits with code 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'));
  const inputPath = writeInput(dir, {
    orders: [{ orderId: 'o1', charged: 100 }],
    requests: [{ requestId: 'r1', type: 'REFUND', orderId: 'ghost', amount: 10 }],
  });
  const outputPath = path.join(dir, 'output.json');
  const run = runCli(['history', inputPath, outputPath]);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /unknown order/);
  assert.ok(!fs.existsSync(outputPath));
});

test('CLI: invalid amount exits with code 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'));
  const inputPath = writeInput(dir, {
    orders: [{ orderId: 'o1', charged: 100 }],
    requests: [{ requestId: 'r1', type: 'REFUND', orderId: 'o1', amount: -3 }],
  });
  const outputPath = path.join(dir, 'output.json');
  const run = runCli(['history', inputPath, outputPath]);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /invalid amount/);
});

test('CLI: UNSAT and PENDING still exit 0 with output written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'));
  const inputPath = writeInput(dir, {
    orders: [{ orderId: 'o1', charged: 100 }],
    requests: [{ requestId: 'r1', type: 'REFUND', orderId: 'o1', amount: 500 }],
  });
  const outputPath = path.join(dir, 'output.json');
  const run = runCli(['history', inputPath, outputPath]);
  assert.equal(run.code, 0);
  const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(output.status, 'UNSAT');
  assert.deepEqual(output.conflictCycle, ['r1']);
});

test('CLI: missing arguments exit with code 1', () => {
  assert.equal(runCli([]).code, 1);
  assert.equal(runCli(['history']).code, 1);
  assert.equal(runCli(['bogus', 'a', 'b']).code, 1);
});
