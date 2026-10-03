'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');
const { ts } = require('../test-support/helpers');

test('revoking a receipt releases the internal row and keeps match history', () => {
  const engine = new Engine({ rulesVersion: 'v1' });
  engine.apply({ type: 'internal', id: 'I1', amount: 100, ts: ts(10) });
  engine.apply({ type: 'external', id: 'E1', amount: 100, ts: ts(11) });
  assert.equal(engine.getDifferenceClusters().length, 0); // settled pair

  engine.apply({ type: 'revoke', id: 'E1' });

  // internal row released -> difference cluster with re-upload suggestion
  const clusters = engine.getDifferenceClusters();
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].status, 'OPEN');
  assert.deepEqual(clusters[0].memberKeys, ['I:I1']);
  assert.ok(
    clusters[0].suggestions.some((s) => s.action === 'REQUEST_RECEIPT_REUPLOAD')
  );
  // revoked external is out of the graph but the match is preserved in history
  assert.equal(engine.history.length, 1);
  assert.equal(engine.history[0].type, 'REVOKED_MATCH');
  assert.equal(engine.history[0].external, 'E:E1');
  assert.deepEqual(engine.history[0].releasedInternals, ['I:I1']);

  // re-upload (补传) a replacement receipt -> settles again, history retained
  engine.apply({ type: 'external', id: 'E2', amount: 100, ts: ts(12) });
  assert.equal(engine.getDifferenceClusters().length, 0);
  assert.equal(engine.history.length, 1);
});

test('amount correction after re-upload produces a CORRECT_AMOUNT suggestion', () => {
  const engine = new Engine({ rulesVersion: 'v2' });
  engine.apply({ type: 'internal', id: 'I1', amount: 100, ts: ts(10) });
  engine.apply({ type: 'external', id: 'E1', amount: 100, ts: ts(10) });
  engine.apply({ type: 'correct', id: 'E1', amount: 101.5 });

  const clusters = engine.getDifferenceClusters();
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].status, 'AMOUNT_MISMATCH');
  const fix = clusters[0].suggestions.find((s) => s.action === 'CORRECT_AMOUNT');
  assert.equal(fix.deltaCents, 150);
  assert.equal(fix.internal, 'I:I1');
  assert.equal(fix.external, 'E:E1');
});

test('revoke of unknown or already-revoked receipt is an error', () => {
  const engine = new Engine();
  assert.throws(() => engine.apply({ type: 'revoke', id: 'nope' }), /unknown external/);
  engine.apply({ type: 'external', id: 'E1', amount: 1, ts: ts(0) });
  engine.apply({ type: 'revoke', id: 'E1' });
  assert.throws(() => engine.apply({ type: 'revoke', id: 'E1' }), /already revoked/);
});
