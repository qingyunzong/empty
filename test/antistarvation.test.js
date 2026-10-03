'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeConfig, makeStore, submitEvent, engine } = require('./helpers');

test('acceptance 2: waiting tenant is boosted after threshold while hog fills capacity', () => {
  const store = makeStore();
  const config = makeConfig({
    workers: [{ id: 'w1', throughput: 10, maxClassification: 3 }],
    waitThreshold: 5,
  });
  const hog1 = submitEvent('hog-1', { tenant: 'hog', size: 10, deadline: 5, enqueuedAt: 0, now: 0, lamport: 1 });
  const r1 = engine.execute(store, config, 'submit', [hog1]);
  assert.equal(r1.results[0].schedule.assignments[0].packId, 'hog-1', 'hog fills the worker');

  const waiter = submitEvent('wait-1', { tenant: 'waiter', size: 4, deadline: 40, enqueuedAt: 0, now: 0, lamport: 2 });
  const r2 = engine.execute(store, config, 'submit', [waiter]);
  assert.equal(r2.results[0].schedule.assignments.length, 0, 'waiter deferred while capacity is full');
  assert.equal(store.state.packs['wait-1'].status, 'queued');

  engine.execute(store, config, 'verify', [{ lamport: 3, client: 'c', hash: 'v-hog', packId: 'hog-1' }]);

  const hog2 = submitEvent('hog-2', { tenant: 'hog', size: 10, deadline: 30, enqueuedAt: 6, now: 6, lamport: 4 });
  hog2.now = 6;
  const r3 = engine.execute(store, config, 'submit', [hog2]);
  const assigned = Object.fromEntries(r3.results[0].schedule.assignments.map((a) => [a.packId, a]));
  assert.ok(assigned['wait-1'], 'long-waiting tenant promoted ahead of fresh hog pack');
  assert.equal(assigned['wait-1'].boosted, true, 'promotion marked as boosted');
  assert.equal(assigned['wait-1'].waited, 6);
  assert.equal(assigned['hog-2'], undefined, 'fresh hog pack yields to boosted waiter');
  assert.equal(store.state.packs['wait-1'].boosted, true);

  const worker = config.workers[0];
  assert.ok(
    worker.maxClassification >= store.state.packs['wait-1'].classification,
    'boost never breaks the classification ceiling'
  );
});
