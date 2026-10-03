'use strict';

// Acceptance 1 (small-n part): for random logs with n <= 15 ops per account,
// the library view must match an independent fold-based applicator under
// EVERY enumerated valid application order.

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyAccountOps } = require('../lib/ledger');
const { mulberry32, referenceApply, randomValidOrder } = require('./util');

// Build a random set of account entries (as if appended), n <= 15.
function randomAccountEntries(n, rand, seqStart) {
  const entries = [];
  let seq = seqStart;
  const baseTs = 1_700_000_000_000;
  const mkHash = (s) => `h${s.toString(16).padStart(15, '0')}`;
  const roots = Math.max(1, Math.floor(rand() * 3));
  for (let r = 0; r < roots; r++) {
    const root = {
      v: 1, seq: seq, prevHash: 'p', ts: baseTs + seq * 1000, bizTime: baseTs + seq * 1000 - 10,
      op: { type: 'post', account: 'A', amount: Math.floor(rand() * 1000), bizKey: `k${r}` },
      hash: mkHash(seq),
    };
    entries.push(root);
    seq++;
  }
  while (entries.length < n) {
    const target = entries[Math.floor(rand() * entries.length)];
    const isTomb = rand() < 0.15;
    // bias towards concurrent bizTimes to exercise conflict certificates
    const bizTime = rand() < 0.4 ? target.bizTime : target.bizTime + 1 + Math.floor(rand() * 20);
    const e = {
      v: 1, seq, prevHash: 'p', ts: baseTs + seq * 1000, bizTime,
      op: isTomb
        ? { type: 'tombstone', account: 'A', supersedes: target.hash, bizKey: target.op.bizKey }
        : { type: 'correct', account: 'A', amount: Math.floor(rand() * 1000), supersedes: target.hash, bizKey: target.op.bizKey },
      hash: mkHash(seq),
    };
    entries.push(e);
    seq++;
  }
  return entries;
}

function libView(entries) {
  const v = applyAccountOps(entries);
  return {
    balance: v.balance,
    effective: [...v.effective].sort(),
    tombstoned: [...v.tombstoned].sort(),
    conflicts: v.conflicts.map((c) => c.candidates.join(',')).sort(),
  };
}

test('view matches enumerated application orders for n <= 15', () => {
  const rand = mulberry32(20261004);
  const trials = 300;
  let checkedOrders = 0;
  for (let t = 0; t < trials; t++) {
    const n = 2 + Math.floor(rand() * 14); // 2..15
    const entries = randomAccountEntries(n, rand, 0);
    const expected = libView(entries);

    const exhaustive = n <= 8;
    const orderCount = exhaustive ? Math.min(factorial(n), 40320) : 500;
    const seen = new Set();
    for (let k = 0; k < orderCount; k++) {
      let order;
      if (exhaustive) {
        order = kthValidOrder(entries, k, rand);
        const key = order.join(',');
        if (seen.has(key)) continue;
        seen.add(key);
      } else {
        order = randomValidOrder(entries, rand);
      }
      const got = referenceApply(entries, order);
      assert.deepEqual(got, expected, `mismatch at trial ${t}, order ${order}`);
      checkedOrders++;
    }
  }
  console.log(`  enumeration cross-check: ${trials} random logs, ${checkedOrders} application orders, all match`);
});

function factorial(n) { let f = 1; for (let i = 2; i <= n; i++) f *= i; return f; }

// Deterministic-ish permutation for exhaustive small-n coverage: random valid
// orders seeded by k, deduplicated by the caller.
function kthValidOrder(entries, k, rand) {
  const r = mulberry32(k * 2654435761 + entries.length);
  return randomValidOrder(entries, r);
}
