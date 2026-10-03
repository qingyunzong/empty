'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Store } = require('../src/store.js');
const { makeDir, independentUsed } = require('./helpers.js');

test('acceptance 1: three-level freeze chain balances match independent recursive sum', () => {
  const store = new Store(makeDir());

  store.freeze({ id: 'root', parentId: null, amount: 10, quota: 100, policyText: 'root policy' });
  store.freeze({ id: 'mid', parentId: 'root', amount: 20, quota: 50, policyText: 'mid policy' });
  const result = store.freeze({ id: 'leaf', parentId: 'mid', amount: 15, quota: 30, policyText: 'leaf policy' });

  const allRequests = [...store.requests.values()];
  for (const id of ['root', 'mid', 'leaf']) {
    assert.equal(store.used(id), independentUsed(allRequests, id), `used(${id})`);
  }

  const levels = Object.fromEntries(result.levels.map((level) => [level.id, level]));
  assert.deepEqual(
    { pre: levels.root.preBalance, post: levels.root.postBalance },
    { pre: 100 - 30, post: 100 - 45 },
  );
  assert.deepEqual(
    { pre: levels.mid.preBalance, post: levels.mid.postBalance },
    { pre: 50 - 20, post: 50 - 35 },
  );
  assert.deepEqual(
    { pre: levels.leaf.preBalance, post: levels.leaf.postBalance },
    { pre: 30, post: 30 - 15 },
  );

  assert.deepEqual(
    result.occupancyChain.map((node) => [node.id, node.used]),
    [['root', 45], ['mid', 35], ['leaf', 15]],
  );

  assert.equal(result.certificate.id, 'leaf');
  assert.equal(result.certificate.version, 1);
  assert.match(result.certificate.digest, /^[0-9a-f]{64}$/);

  for (const id of ['root', 'mid', 'leaf']) {
    assert.equal(store.balance(id), store.requests.get(id).quota - independentUsed(allRequests, id));
  }
});
