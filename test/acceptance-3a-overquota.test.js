'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Store, QuotaError, NotFoundError } = require('../src/store.js');
const { makeDir } = require('./helpers.js');

test('acceptance 3a: over-quota freeze fails and state is unchanged', () => {
  const store = new Store(makeDir());
  store.freeze({ id: 'root', parentId: null, amount: 10, quota: 100, policyText: 'root' });
  store.freeze({ id: 'child', parentId: 'root', amount: 20, quota: 50, policyText: 'child' });

  const before = JSON.stringify([...store.requests.values()]);
  assert.throws(
    () => store.freeze({ id: 'big', parentId: 'root', amount: 95, quota: 200, policyText: 'too big' }),
    QuotaError,
  );
  assert.equal(JSON.stringify([...store.requests.values()]), before);
  assert.equal(store.used('root'), 30);
  assert.throws(() => store.get('big'), NotFoundError);
});
