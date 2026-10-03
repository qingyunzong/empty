'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Account } = require('../lib/account');
const { runBrute } = require('./helpers/brute');

function mulberry32(seed) {
  let t = seed >>> 0;
  return function rng() {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function randomOps(rng, count, totalLimit) {
  const ops = [];
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    const kind = rng();
    const ts = 1 + Math.floor(rng() * 8); // small ts range -> frequent ties
    let id;
    if (ids.length > 0 && rng() < 0.1) {
      id = ids[Math.floor(rng() * ids.length)]; // occasional duplicate id
    } else {
      id = `op${i}`;
      ids.push(id);
    }
    if (kind < 0.35) {
      const start = Math.floor(rng() * (totalLimit + 1));
      const end = Math.floor(rng() * (totalLimit + 1));
      ops.push({ ts, id, op: 'freeze', start, end });
    } else if (kind < 0.6) {
      const start = Math.floor(rng() * (totalLimit + 1));
      const end = Math.floor(rng() * (totalLimit + 1));
      ops.push({ ts, id, op: 'unfreeze', start, end });
    } else {
      const scopes = ['x', 'y', 'z'];
      ops.push({
        ts, id, op: 'debit',
        amount: 1 + Math.floor(rng() * 40),
        scope: scopes[Math.floor(rng() * scopes.length)],
      });
    }
  }
  return ops;
}

for (const seed of [1, 2, 3, 42, 1337]) {
  test(`random 100 ops match brute-force interval model (seed ${seed})`, () => {
    const totalLimit = 50;
    const config = { totalLimit, categoryLimits: { x: 20, y: 30 } };
    const rng = mulberry32(seed);
    const ops = randomOps(rng, 100, totalLimit);

    const account = new Account(config);
    const report = account.applyAll(ops);
    const expected = runBrute(config, ops);

    assert.equal(report.steps.length, expected.length);
    for (let i = 0; i < expected.length; i += 1) {
      const got = report.steps[i];
      const want = expected[i];
      assert.equal(got.id, want.id, `step ${i} id`);
      assert.equal(got.ok, want.ok, `step ${i} (${want.id}) ok`);
      assert.equal(got.reason, want.reason, `step ${i} (${want.id}) reason`);
      assert.equal(got.available, want.available, `step ${i} (${want.id}) available`);
      assert.deepEqual(got.frozen, want.frozen, `step ${i} (${want.id}) frozen`);
    }
    const last = expected[expected.length - 1];
    assert.equal(report.final.available, last.available);
    assert.deepEqual(report.final.frozen, last.frozen);
    assert.equal(report.final.debitedTotal, last.debitedTotal);
    assert.deepEqual(report.final.debitedByScope, last.debitedByScope);
  });
}
