'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { Store, NotFoundError } = require('../src/store.js');
const { makeDir } = require('./helpers.js');

test('acceptance 2: expire hides phrase, restore revives it, purge survives restart', () => {
  const dir = makeDir();
  let store = new Store(dir);
  store.freeze({ id: 'doc', parentId: null, amount: 5, quota: 10, policyText: 'alpha beta gamma' });

  assert.deepEqual(store.query('beta gamma'), ['doc']);
  assert.deepEqual(store.query('gamma beta'), []);
  assert.deepEqual(store.query('alpha beta gamma'), ['doc']);

  store.expire('doc');
  assert.deepEqual(store.query('beta gamma'), []);

  store.restore('doc');
  assert.deepEqual(store.query('beta gamma'), ['doc']);

  store.expire('doc');
  store.purge();

  const segFiles = fs.readdirSync(path.join(dir, 'segments')).filter((n) => n.endsWith('.json.gz'));
  assert.equal(segFiles.length, 1, 'purge must merge segments into one');

  store = new Store(dir);
  assert.deepEqual(store.query('beta gamma'), []);
  assert.throws(() => store.get('doc'), NotFoundError);
  assert.throws(() => store.restore('doc'), NotFoundError);
});
