'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, priorityCmp } = require('../lib/core');
const { AppendOnlyLog } = require('../lib/log');
const { TYPE } = require('../lib/frame');

// Brute-force reference allocation: sort by the deterministic priority rule,
// then hand each request min(remaining, requested). Independent of the engine.
function bruteForceAllocate(requests, cap) {
  const sorted = [...requests].sort(priorityCmp);
  let remaining = cap;
  const granted = new Map();
  for (const r of sorted) {
    const g = Math.min(r.amount, Math.max(0, remaining));
    granted.set(r.reqId, g);
    remaining -= g;
  }
  return granted;
}

function engineAllocate(requests, cap, order) {
  const entries = [];
  const engine = new Engine({ budgetCap: cap, ttl: 1000, log: new AppendOnlyLog(null), emit: (e) => entries.push(e) });
  order.forEach((idx, i) => {
    const r = requests[idx];
    engine.ingest({ type: TYPE.RESERVE, member: r.member, reqId: r.reqId, amount: r.amount, seq: i + 1, tick: 0 });
  });
  engine.flush();
  return new Map(entries.map((e) => [e.reqId, e.granted]));
}

function* permutations(n) {
  const idx = Array.from({ length: n }, (_, i) => i);
  yield idx.slice();
  const c = new Array(n).fill(0);
  let i = 0;
  while (i < n) {
    if (c[i] < i) {
      const j = i % 2 === 0 ? 0 : c[i];
      [idx[i], idx[j]] = [idx[j], idx[i]];
      yield idx.slice();
      c[i]++;
      i = 0;
    } else {
      c[i] = 0;
      i++;
    }
  }
}

test('acceptance 5: allocation is arrival-order independent (all 6! permutations)', () => {
  const requests = [
    { member: 'anna', reqId: 1, amount: 10 },
    { member: 'beth', reqId: 2, amount: 20 },
    { member: 'cora', reqId: 3, amount: 20 }, // amount tie with beth
    { member: 'dana', reqId: 4, amount: 30 },
    { member: 'elle', reqId: 5, amount: 40 },
    { member: 'fern', reqId: 6, amount: 50 },
  ];
  const cap = 65;
  const expected = bruteForceAllocate(requests, cap);
  let runs = 0;
  for (const order of permutations(requests.length)) {
    assert.deepEqual(engineAllocate(requests, cap, order), expected, `order ${order}`);
    runs++;
  }
  assert.equal(runs, 720);
});

test('acceptance 5: every subset of an 8-request pool matches brute force', () => {
  const pool = [
    { member: 'a', reqId: 1, amount: 5 },
    { member: 'b', reqId: 2, amount: 10 },
    { member: 'c', reqId: 3, amount: 15 },
    { member: 'd', reqId: 4, amount: 20 },
    { member: 'e', reqId: 5, amount: 25 },
    { member: 'f', reqId: 6, amount: 30 },
    { member: 'g', reqId: 7, amount: 35 },
    { member: 'h', reqId: 8, amount: 40 },
  ];
  const cap = 100;
  let runs = 0;
  for (let mask = 1; mask < 256; mask++) {
    const subset = pool.filter((_, i) => mask & (1 << i));
    const expected = bruteForceAllocate(subset, cap);
    assert.deepEqual(engineAllocate(subset, cap, subset.map((_, i) => i)), expected, `mask ${mask}`);
    runs++;
  }
  assert.equal(runs, 255);
});

test('acceptance 5: deterministic fuzz (n<=8) matches brute force and keeps the budget invariant', () => {
  let seed = 0x5eed;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let trial = 0; trial < 200; trial++) {
    const n = 1 + Math.floor(rand() * 8);
    const cap = Math.floor(rand() * 200);
    const requests = Array.from({ length: n }, (_, i) => ({
      member: `m${i}`,
      reqId: i + 1,
      amount: Math.floor(rand() * 100),
    }));
    const expected = bruteForceAllocate(requests, cap);
    const actual = engineAllocate(requests, cap, requests.map((_, i) => i));
    assert.deepEqual(actual, expected, `trial ${trial}`);
    const total = [...actual.values()].reduce((a, b) => a + b, 0);
    assert.ok(total <= cap, `trial ${trial} exceeds budget`);
  }
});
