'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reduceEvents } = require('../lib/reduce');
const { mulberry32 } = require('./helpers');
const { canonical, sha256 } = require('../lib/util');

function* permutations(arr) {
  const a = arr.slice();
  const n = a.length;
  const c = new Array(n).fill(0);
  yield a.slice();
  let i = 0;
  while (i < n) {
    if (c[i] < i) {
      const j = i % 2 === 0 ? 0 : c[i];
      [a[j], a[i]] = [a[i], a[j]];
      c[i] += 1;
      i = 0;
      yield a.slice();
    } else {
      c[i] = 0;
      i += 1;
    }
  }
}

function genEvents(seed, n) {
  const rng = mulberry32(seed);
  const events = [];
  const accounts = ['x', 'y', 'z'];
  const txIds = [];
  for (let i = 1; i <= n; i += 1) {
    const roll = rng();
    const acc = accounts[Math.floor(rng() * accounts.length)];
    if (roll < 0.5 || txIds.length === 0) {
      const txId = `t${i}`;
      // sometimes reuse an existing txId to exercise last-write-wins
      const id = txIds.length > 0 && rng() < 0.25 ? txIds[Math.floor(rng() * txIds.length)] : txId;
      events.push({ seq: i, txId: id, op: 'credit', account: acc, amount: 1 + Math.floor(rng() * 1000) });
      txIds.push(id);
    } else {
      const ref = txIds[Math.floor(rng() * txIds.length)];
      events.push({ seq: i, txId: `u${i}`, op: 'undo', ref });
    }
  }
  return events;
}

function fingerprint(events) {
  const state = reduceEvents(events, { enforceNonNegative: true });
  return sha256(canonical(state));
}

test('n<=8: exhaustive permutation replay yields identical final balances', () => {
  for (let n = 1; n <= 8; n += 1) {
    const events = genEvents(1000 + n, n);
    const expected = fingerprint(events);
    let count = 0;
    for (const perm of permutations(events)) {
      assert.equal(fingerprint(perm), expected, `n=${n} permutation ${JSON.stringify(perm)}`);
      count += 1;
    }
    let factorial = 1;
    for (let k = 2; k <= n; k += 1) factorial *= k;
    assert.equal(count, factorial);
  }
});

test('9<=n<=12: sampled permutation replay (2000 per n) yields identical final balances', () => {
  for (let n = 9; n <= 12; n += 1) {
    const events = genEvents(2000 + n, n);
    const expected = fingerprint(events);
    const rng = mulberry32(3000 + n);
    for (let iter = 0; iter < 2000; iter += 1) {
      const perm = events.slice();
      for (let i = perm.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [perm[i], perm[j]] = [perm[j], perm[i]];
      }
      assert.equal(fingerprint(perm), expected, `n=${n} iter=${iter}`);
    }
  }
});
