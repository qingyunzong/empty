'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  QuotaEngine,
  E_INSUFFICIENT_FUNDS,
  E_TXN_STATE,
} = require('../src');

test('one transaction freezes multiple accounts atomically', async () => {
  const engine = QuotaEngine.open({ lockTimeoutMs: 200 });
  engine.addAccount('A', 1000, 1);
  engine.addAccount('B', 500, 2);
  engine.addAccount('C', 100, 3);
  const txn = engine.begin();
  await engine.freeze(txn, 'A', 200);
  await engine.freeze(txn, 'B', 100);
  await engine.freeze(txn, 'C', 50);
  const { freezeId, items } = await engine.commit(txn);
  assert.equal(freezeId, 'F1');
  assert.equal(items.length, 3);
  assert.equal(engine.availableOf('A'), 800);
  assert.equal(engine.availableOf('B'), 400);
  assert.equal(engine.availableOf('C'), 50);
  engine.close();
});

test('MVCC snapshot is stable, but commit validates latest committed balances', async () => {
  const engine = QuotaEngine.open({ lockTimeoutMs: 200 });
  engine.addAccount('A', 100, 1);

  const reader = engine.begin();
  const snapshotAtBegin = reader && engine.transactions.get(reader).snapshot;
  assert.equal(snapshotAtBegin.balances.get('A'), 100);

  // Another transaction commits a freeze of 60 in the meantime.
  const other = engine.begin();
  await engine.freeze(other, 'A', 60);
  await engine.commit(other);

  // The reader's snapshot still shows the old committed balance (MVCC)...
  const readerTxn = engine.transactions.get(reader);
  assert.equal(readerTxn.snapshot.balances.get('A'), 100);
  assert.ok(readerTxn.snapshot.version < engine.snapshot().version);

  // ...but its freeze is validated against the latest committed state:
  // only 40 is still available, so freezing 50 must fail at commit.
  await engine.freeze(reader, 'A', 50);
  await assert.rejects(engine.commit(reader), (err) => {
    assert.equal(err.code, E_INSUFFICIENT_FUNDS);
    return true;
  });
  assert.equal(engine.transactions.get(reader).state, 'aborted');
  assert.equal(engine.availableOf('A'), 40);
  engine.close();
});

test('(priority, account) secondary index orders freeze scans', async () => {
  const engine = QuotaEngine.open({ lockTimeoutMs: 200 });
  engine.addAccount('low', 1000, 1);
  engine.addAccount('high', 1000, 9);
  engine.addAccount('mid', 1000, 5);

  const t1 = engine.begin();
  await engine.freeze(t1, 'high', 10);
  await engine.commit(t1);
  const t2 = engine.begin();
  await engine.freeze(t2, 'low', 10);
  await engine.commit(t2);
  const t3 = engine.begin();
  await engine.freeze(t3, 'mid', 10);
  await engine.commit(t3);

  const scan = engine.scanByPriority();
  assert.deepEqual(
    scan.map((group) => group.items[0].account),
    ['low', 'mid', 'high']
  );
  engine.close();
});

test('unfreeze releases the freeze and the lock inside the transaction', async () => {
  const engine = QuotaEngine.open({ lockTimeoutMs: 50 });
  engine.addAccount('A', 1000, 1);
  const t1 = engine.begin();
  await engine.freeze(t1, 'A', 300);
  engine.unfreeze(t1, 'A');

  // The lock is gone, so another transaction grabs A immediately.
  const t2 = engine.begin();
  await engine.freeze(t2, 'A', 100);
  await engine.commit(t2);

  // t1 commits nothing for A.
  const result = await engine.commit(t1);
  assert.equal(result.items.length, 0);
  assert.equal(engine.availableOf('A'), 900);
  engine.close();
});

test('abort releases locks and discards pending freezes', async () => {
  const engine = QuotaEngine.open({ lockTimeoutMs: 50 });
  engine.addAccount('A', 1000, 1);
  const t1 = engine.begin();
  await engine.freeze(t1, 'A', 300);
  engine.abort(t1);
  assert.equal(engine.transactions.get(t1).state, 'aborted');

  const t2 = engine.begin();
  await engine.freeze(t2, 'A', 300);
  await engine.commit(t2);
  assert.equal(engine.availableOf('A'), 700);

  await assert.rejects(engine.freeze(t1, 'A', 1), (err) => {
    assert.equal(err.code, E_TXN_STATE);
    return true;
  });
  engine.close();
});
