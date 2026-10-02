'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { runSample, selectionKey } = require('../src/index');

// Independent reference implementation: brute-force enumeration of all keys.
function referenceSample(seed, stratum, ids, quota) {
  const keyed = ids.map((id) => ({
    id,
    key: crypto.createHash('sha256').update('sample|' + seed + '|' + stratum + '|' + id).digest('hex'),
  }));
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return keyed.slice(0, quota).map((entry) => entry.id);
}

test('n<=12: library selection matches independent stratified enumeration', () => {
  for (let n = 1; n <= 12; n += 1) {
    const ids = Array.from({ length: n }, (_, i) => 'rec-' + i);
    const ledger = ids.map((id, i) => ({
      id, stratum: 'S', version: 1, source: 'nodeA', seq: i, amount: i,
    }));
    for (let quota = 0; quota <= n; quota += 1) {
      const request = {
        seed: 'enum-seed',
        version: 1,
        ledger,
        strata: [{ id: 'S', quota }],
      };
      const { output } = runSample(request, null);
      const actual = output.samples[0].records.map((r) => r.id);
      const expected = referenceSample('enum-seed', 'S', ids, quota);
      assert.deepEqual(actual, expected, `n=${n} quota=${quota}`);
    }
  }
});

test('keys are deterministic and uniform-looking: frequency sanity over many seeds', () => {
  // For n=4, k=2 each record should be selected with probability 0.5.
  const n = 4;
  const k = 2;
  const trials = 2000;
  const ids = Array.from({ length: n }, (_, i) => 'rec-' + i);
  const counts = new Map(ids.map((id) => [id, 0]));
  for (let t = 0; t < trials; t += 1) {
    const seed = 'freq-seed-' + t;
    const keyed = ids
      .map((id) => ({ id, key: selectionKey(seed, 'S', id) }))
      .sort((a, b) => (a.key < b.key ? -1 : 1));
    for (const entry of keyed.slice(0, k)) {
      counts.set(entry.id, counts.get(entry.id) + 1);
    }
  }
  const expected = (k / n) * trials;
  for (const [id, count] of counts) {
    // Generous tolerance (5%) around the exact expectation of 1000.
    assert.ok(Math.abs(count - expected) < expected * 0.08,
      `${id} selected ${count} times, expected ~${expected}`);
  }
});
