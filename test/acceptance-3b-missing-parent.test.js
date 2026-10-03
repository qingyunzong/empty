'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Store, NotFoundError } = require('../src/store.js');
const { makeDir } = require('./helpers.js');

test('acceptance 3b: freeze with missing parent fails and state is unchanged', () => {
  const store = new Store(makeDir());
  store.freeze({ id: 'root', parentId: null, amount: 10, quota: 100, policyText: 'root' });

  const before = JSON.stringify([...store.requests.values()]);
  assert.throws(
    () => store.freeze({ id: 'orphan', parentId: 'ghost', amount: 5, quota: 10, policyText: 'orphan' }),
    NotFoundError,
  );
  assert.equal(JSON.stringify([...store.requests.values()]), before);
  assert.equal(store.used('root'), 10);
});
