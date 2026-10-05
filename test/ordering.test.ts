import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

test('same tick: revoke sequenced before commit rejects the commit', () => {
  const { ledger, engine, store } = setup();
  ledger.grant(1, 'alice', 'dataset');
  engine.openBatch(2, 'b1', 'alice', 'dataset');
  engine.cacheBlock('b1', { id: 'blk-1', data: 'aaa' });

  const tick = 9;
  ledger.revoke(tick, 'alice', 'dataset');
  const evidence = engine.commit(tick, 'b1', 'object-1');

  assert.equal(evidence.decision, 'rejected');
  assert.equal(store.history('object-1').length, 0);
});

test('same tick: commit sequenced before revoke is accepted', () => {
  const { ledger, engine, store } = setup();
  ledger.grant(1, 'alice', 'dataset');
  engine.openBatch(2, 'b1', 'alice', 'dataset');
  engine.cacheBlock('b1', { id: 'blk-1', data: 'aaa' });

  const tick = 9;
  const evidence = engine.commit(tick, 'b1', 'object-1');
  ledger.revoke(tick, 'alice', 'dataset');

  assert.equal(evidence.decision, 'accepted');
  assert.equal(store.history('object-1').length, 1);
});

test('event sequence, not tick value, decides same-tick resolution', () => {
  const { ledger, engine, log } = setup();
  ledger.grant(1, 'alice', 'dataset');
  engine.openBatch(2, 'b1', 'alice', 'dataset');
  engine.cacheBlock('b1', { id: 'blk-1', data: 'aaa' });

  ledger.revoke(10, 'alice', 'dataset');
  const evidence = engine.commit(5, 'b1', 'object-1');

  assert.equal(evidence.decision, 'rejected');
  const commitEvent = log.all().find((e) => e.kind === 'batch.commit')!;
  const revokeEvent = log.all().find((e) => e.kind === 'permission.revoke')!;
  assert.ok(revokeEvent.seq < commitEvent.seq);
  assert.ok(commitEvent.tick < revokeEvent.tick);
});
