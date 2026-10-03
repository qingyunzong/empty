'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { solveInstance, minimalConflict } = require('../lib/solve');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Brute-force reference: enumerate every assignment of transactions to batches.
function bruteForceSat(txs, batchIds, limits) {
  const used = new Map();
  const key = (a, b) => `${a}|${b}`;
  function go(i) {
    if (i === txs.length) return true;
    const tx = txs[i];
    for (const b of tx.domain) {
      const k = key(tx.account, b);
      const next = (used.get(k) || 0) + tx.amount;
      if (next <= limits[tx.account]) {
        used.set(k, next);
        if (go(i + 1)) return true;
        used.set(k, next - tx.amount);
      }
    }
    return false;
  }
  return go(0);
}

test('solver verdict matches brute-force enumeration (<=3 txs, 2 batches)', () => {
  const batchIds = ['B1', 'B2'];
  for (let seed = 1; seed <= 500; seed++) {
    const rnd = mulberry32(seed);
    const accountIds = rnd() < 0.5 ? ['A'] : ['A', 'B'];
    const limits = {};
    for (const a of accountIds) limits[a] = 10 * Math.floor(rnd() * 16); // 0..150
    const nTx = 1 + Math.floor(rnd() * 3);
    const txs = [];
    for (let i = 0; i < nTx; i++) {
      const domain = batchIds.filter(() => rnd() < 0.7);
      txs.push({
        id: `T${i}`,
        account: accountIds[Math.floor(rnd() * accountIds.length)],
        amount: 10 * (1 + Math.floor(rnd() * 12)), // 10..120
        domain,
      });
    }
    const capacityOf = (account) => limits[account];
    const expected = bruteForceSat(txs, batchIds, limits);
    const got = solveInstance(txs, batchIds, capacityOf).ok;
    assert.equal(got, expected, `seed ${seed}: ${JSON.stringify({ limits, txs })}`);

    if (!got) {
      // the conflict set must itself reproduce infeasibility
      const conflict = minimalConflict(txs, batchIds, capacityOf);
      assert.ok(conflict !== null, `seed ${seed}: missing conflict`);
      const inSet = new Set(conflict.map((p) => `${p.account}|${p.batch}`));
      const contained = txs.filter((tx) => tx.domain.every((b) => inSet.has(`${tx.account}|${b}`)));
      if (contained.length > 0) {
        assert.equal(bruteForceSat(contained, batchIds, limits), false, `seed ${seed}: conflict not unsat`);
      }
    }
  }
});
