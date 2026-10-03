'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Store, StaleVersionError } = require('../src/store.js');
const { makeDir } = require('./helpers.js');

test('acceptance 3c: stale version write is rejected and state is unchanged', () => {
  const store = new Store(makeDir());
  store.freeze({ id: 'root', parentId: null, amount: 10, quota: 100, policyText: 'original text' });

  const before = JSON.stringify(store.requests.get('root'));
  assert.throws(
    () => store.update('root', 99, { policyText: 'forged write', quota: 5 }),
    StaleVersionError,
  );
  assert.equal(JSON.stringify(store.requests.get('root')), before);
  assert.deepEqual(store.query('forged write'), []);
  assert.deepEqual(store.query('original text'), ['root']);

  const ok = store.update('root', 1, { policyText: 'updated text' });
  assert.equal(ok.request.version, 2);
  assert.deepEqual(store.query('updated text'), ['root']);
  assert.deepEqual(store.query('original text'), []);
});
