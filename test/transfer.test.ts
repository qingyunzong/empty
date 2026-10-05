import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

test('batch binds the permission version current at open time', () => {
  const { ledger, engine } = setup();
  ledger.grant(1, 'alice', 'dataset');
  const first = engine.openBatch(2, 'b1', 'alice', 'dataset');
  assert.equal(first.decision, 'accepted');
  assert.equal(first.boundPermissionVersion, 1);

  ledger.grant(3, 'bob', 'dataset');
  ledger.revoke(4, 'bob', 'dataset');
  const second = engine.openBatch(5, 'b2', 'alice', 'dataset');
  assert.equal(second.decision, 'accepted');
  assert.equal(second.boundPermissionVersion, 3);
});

test('open is rejected without an effective grant', () => {
  const { engine } = setup();
  const evidence = engine.openBatch(1, 'b1', 'alice', 'dataset');
  assert.equal(evidence.decision, 'rejected');
  assert.equal(evidence.reason, 'no permission record');
  assert.throws(() => engine.cacheBlock('b1', { id: 'blk-1', data: 'x' }));
});

test('commit publishes cached blocks and published object keeps full history', () => {
  const { ledger, engine, store } = setup();
  ledger.grant(1, 'alice', 'dataset');

  engine.openBatch(2, 'b1', 'alice', 'dataset');
  engine.cacheBlock('b1', { id: 'blk-1', data: 'aaa' });
  engine.cacheBlock('b1', { id: 'blk-2', data: 'bbb' });
  const first = engine.commit(3, 'b1', 'object-1');
  assert.equal(first.decision, 'accepted');

  engine.openBatch(4, 'b2', 'alice', 'dataset');
  engine.cacheBlock('b2', { id: 'blk-3', data: 'ccc' });
  const second = engine.commit(5, 'b2', 'object-1');
  assert.equal(second.decision, 'accepted');

  const history = store.history('object-1');
  assert.equal(history.length, 2);
  assert.deepEqual(history[0]!.blockIds, ['blk-1', 'blk-2']);
  assert.deepEqual(history[1]!.blockIds, ['blk-3']);
  assert.equal(store.latest('object-1')!.version, 2);
});

test('revocation before commit rejects the commit and discards cached blocks', () => {
  const { ledger, engine, store } = setup();
  ledger.grant(1, 'alice', 'dataset');
  engine.openBatch(2, 'b1', 'alice', 'dataset');
  engine.cacheBlock('b1', { id: 'blk-1', data: 'aaa' });

  ledger.revoke(3, 'alice', 'dataset');
  const evidence = engine.commit(4, 'b1', 'object-1');

  assert.equal(evidence.decision, 'rejected');
  assert.equal(evidence.effectivePermission!.effect, 'deny');
  assert.equal(store.history('object-1').length, 0);
  assert.equal(engine.batchView('b1').state, 'aborted');
  assert.throws(() => engine.cacheBlock('b1', { id: 'blk-2', data: 'x' }));
  assert.throws(() => engine.commit(5, 'b1', 'object-1'));
});

test('resume re-verifies permission: revoked denies, re-grant allows again', () => {
  const { ledger, engine } = setup();
  ledger.grant(1, 'alice', 'dataset');
  engine.openBatch(2, 'b1', 'alice', 'dataset');
  engine.cacheBlock('b1', { id: 'blk-1', data: 'aaa' });
  engine.suspend('b1');

  ledger.revoke(3, 'alice', 'dataset');
  const denied = engine.resume(4, 'b1');
  assert.equal(denied.decision, 'rejected');
  assert.equal(denied.reason, 'permission revoked since batch was bound');
  assert.equal(engine.batchView('b1').state, 'suspended');

  ledger.grant(5, 'alice', 'dataset');
  const allowed = engine.resume(6, 'b1');
  assert.equal(allowed.decision, 'accepted');
  assert.equal(engine.batchView('b1').state, 'open');

  const committed = engine.commit(7, 'b1', 'object-1');
  assert.equal(committed.decision, 'accepted');
});

test('published history survives revocation and later rejected commits', () => {
  const { ledger, engine, store } = setup();
  ledger.grant(1, 'alice', 'dataset');
  engine.openBatch(2, 'b1', 'alice', 'dataset');
  engine.cacheBlock('b1', { id: 'blk-1', data: 'aaa' });
  engine.commit(3, 'b1', 'object-1');

  ledger.revoke(4, 'alice', 'dataset');
  ledger.grant(5, 'alice', 'dataset');
  engine.openBatch(6, 'b2', 'alice', 'dataset');
  engine.cacheBlock('b2', { id: 'blk-2', data: 'bbb' });
  ledger.revoke(7, 'alice', 'dataset');
  const rejected = engine.commit(8, 'b2', 'object-1');
  assert.equal(rejected.decision, 'rejected');

  const history = store.history('object-1');
  assert.equal(history.length, 1);
  assert.deepEqual(history[0]!.blockIds, ['blk-1']);
});
