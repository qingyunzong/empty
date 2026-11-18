import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ManualClock,
  QuotaNode,
} from '../src/index.js';

type NodeOptions = ConstructorParameters<typeof QuotaNode>[0];

function makeNode(overrides: Partial<NodeOptions> = {}): QuotaNode {
  return new QuotaNode({
    id: 'a',
    shardLimit: 2,
    windowMs: 10,
    reservationTtlMs: 5,
    clock: new ManualClock(0),
    ...overrides,
  });
}

test('local reservations stop at the shard limit', () => {
  const node = makeNode();
  assert.equal(node.reserve('r1').ok, true);
  assert.equal(node.reserve('r2').ok, true);
  const rejected = node.reserve('r3');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.ok ? undefined : rejected.reason, 'shard_exhausted');
  assert.equal(node.remainingQuota(), 0);
  assert.equal(node.pendingEvents, 2);
});

test('failed reservations never enter the global outbox', () => {
  const node = makeNode();
  node.reserve('r1');
  node.reserve('r2');
  const before = node.pendingEvents;

  assert.equal(node.reserve('r3').ok, false);
  assert.equal(node.reserve('r1').ok, false);
  assert.equal(node.reserve('').ok, false);
  assert.equal(node.pendingEvents, before);
  assert.equal(node.stats.failed, 3);
});

test('commit keeps usage, release returns it', () => {
  const node = makeNode();
  node.reserve('r1');
  node.reserve('r2');
  assert.equal(node.commit('r1'), true);
  assert.equal(node.remainingQuota(), 0);
  assert.deepEqual(
    node.records().map((record) => `${record.id}:${record.state}`),
    ['r1:passed', 'r2:reserved'],
  );

  assert.equal(node.release('r2'), true);
  assert.equal(node.remainingQuota(), 1);
  assert.equal(node.commit('r2'), false);
  assert.equal(node.release('missing'), false);
});

test('timeout releases reservations exactly at their expiry', () => {
  const raw = new ManualClock(0);
  const node = makeNode({ clock: raw, shardLimit: 1 });
  node.reserve('r1');
  const rejected = node.reserve('r2');
  assert.equal(rejected.ok, false);

  raw.advance(4);
  assert.equal(node.remainingQuota(), 0);
  raw.advance(1);
  assert.equal(node.remainingQuota(), 1);
  assert.equal(node.stats.releasedTimeout, 1);
  assert.equal(node.pendingEvents, 2);
});

test('drift correction keeps all timestamps inside the public bound', () => {
  const raw = new ManualClock(100);
  const node = makeNode({ clock: raw, maxClockDriftMs: 4, physicalSkewMs: 3 });
  node.synchronize(100);

  const result = node.reserve('r1');
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.reservation.at : -1, 100);
  assert.equal(node.clock.now(), 100);
  assert.equal(node.effectiveWindowMs, 18);
});
