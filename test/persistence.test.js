'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Store } = require('../src/store.js');
const { makeDir } = require('./helpers.js');

test('persistence: balances and index survive reopen', () => {
  const dir = makeDir();
  let store = new Store(dir);
  store.freeze({ id: 'root', parentId: null, amount: 10, quota: 100, policyText: 'persistent phrase' });
  store.freeze({ id: 'child', parentId: 'root', amount: 25, quota: 60, policyText: 'child doc' });

  store = new Store(dir);
  assert.equal(store.used('root'), 35);
  assert.equal(store.balance('root'), 65);
  assert.deepEqual(store.query('persistent phrase'), ['root']);
  assert.deepEqual(store.query('child doc'), ['child']);
});
