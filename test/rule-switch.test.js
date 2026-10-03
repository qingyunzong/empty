'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');
const { ts } = require('../test-support/helpers');

function onlyCluster(engine) {
  const clusters = engine.getAllClusters();
  assert.equal(clusters.length, 1);
  return clusters[0];
}

test('rule switch cascades: one-to-many group settles under v2, reopens under v1', () => {
  const engine = new Engine({ rulesVersion: 'v1' });
  engine.apply({ type: 'internal', id: 'I1', amount: 60, ts: ts(10) });
  engine.apply({ type: 'internal', id: 'I2', amount: 40, ts: ts(11) });
  engine.apply({ type: 'external', id: 'E1', amount: 100, ts: ts(12) });

  const before = onlyCluster(engine);
  assert.equal(before.status, 'UNRESOLVED');
  assert.deepEqual(before.reasons, ['ONE_TO_MANY_REJECTED']);
  assert.equal(before.matches.groups.length, 0);

  engine.apply({ type: 'rule', version: 'v2' });
  const afterV2 = onlyCluster(engine);
  assert.equal(afterV2.status, 'SETTLED');
  assert.equal(afterV2.matches.groups.length, 1);
  assert.deepEqual(afterV2.matches.groups[0].members, ['I:I1', 'I:I2']);
  assert.equal(afterV2.matches.groups[0].external, 'E:E1');
  // stable cluster id: same membership, same content-hash id across recompute
  assert.equal(afterV2.id, before.id);

  engine.apply({ type: 'rule', version: 'v1' });
  const backToV1 = onlyCluster(engine);
  assert.equal(backToV1.status, 'UNRESOLVED');
  assert.deepEqual(backToV1.reasons, ['ONE_TO_MANY_REJECTED']);
  assert.equal(backToV1.id, before.id);
});

test('rule switch invalidates tolerance-based matches and releases rows', () => {
  const engine = new Engine({ rulesVersion: 'v2' });
  engine.apply({ type: 'internal', id: 'I1', amount: 100, ts: ts(10) });
  engine.apply({ type: 'external', id: 'E1', amount: 104, ts: ts(11) });

  const settled = onlyCluster(engine);
  assert.equal(settled.status, 'AMOUNT_MISMATCH');
  assert.equal(settled.matches.pairs.length, 1);
  assert.ok(
    settled.suggestions.some(
      (s) => s.action === 'CORRECT_AMOUNT' && s.deltaCents === 400
    )
  );

  // v1 tolerance is 0: the pair match is invalidated, both rows released
  engine.apply({ type: 'rule', version: 'v1' });
  const reopened = onlyCluster(engine);
  assert.equal(reopened.status, 'OPEN');
  assert.equal(reopened.matches.pairs.length, 0);
  const states = new Map(reopened.members.map((m) => [m.key, m.state]));
  assert.equal(states.get('I:I1'), 'UNMATCHED_INTERNAL');
  assert.equal(states.get('E:E1'), 'UNMATCHED_EXTERNAL');
  assert.ok(reopened.suggestions.some((s) => s.action === 'REQUEST_RECEIPT_REUPLOAD'));
});

test('unknown rule version is rejected', () => {
  const engine = new Engine();
  assert.throws(() => engine.apply({ type: 'rule', version: 'v9' }), /unknown rule version/);
});
