'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Store } = require('../src/store.js');
const { makeDir } = require('./helpers.js');

test('expired parent rejects new child freeze', () => {
  const store = new Store(makeDir());
  store.freeze({ id: 'root', parentId: null, amount: 10, quota: 100, policyText: 'root' });
  store.expire('root');
  assert.throws(
    () => store.freeze({ id: 'child', parentId: 'root', amount: 5, quota: 10, policyText: 'child' }),
    /not active/,
  );
});
