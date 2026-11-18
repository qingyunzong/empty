import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createQuotaCluster,
} from '../src/index.js';

test('cluster partitions quota and keeps shard limits within it', () => {
  const cluster = createQuotaCluster({
    quota: 7,
    windowMs: 100,
    reservationTtlMs: 30,
    nodes: ['a', 'b', 'c'],
  });

  assert.equal(cluster.totalShardLimit, 7);
  assert.equal(
    cluster.node('a').shardLimit +
      cluster.node('b').shardLimit +
      cluster.node('c').shardLimit,
    7,
  );
  assert.throws(
    () =>
      createQuotaCluster({
        quota: 2,
        windowMs: 100,
        reservationTtlMs: 30,
        nodes: [
          { id: 'a', shardLimit: 2 },
          { id: 'b', shardLimit: 1 },
        ],
      }),
    RangeError,
  );
});

test('reserve, commit and reconcile mirror local state globally', () => {
  const cluster = createQuotaCluster({
    quota: 4,
    windowMs: 100,
    reservationTtlMs: 30,
    nodes: ['a', 'b'],
  });

  assert.equal(cluster.reserve('a', 'r1').ok, true);
  assert.equal(cluster.commit('a', 'r1'), true);
  assert.equal(cluster.reserve('b', 'r2').ok, true);

  const report = cluster.reconcile();
  assert.deepEqual(report.violations, []);
  assert.equal(cluster.audit().inSync, true);
  assert.equal(cluster.audit().ok, true);
  assert.equal(cluster.globalRecords().length, 2);
  assert.deepEqual(
    cluster.globalRecords().map((record) => `${record.id}:${record.state}`).sort(),
    ['a\u0000r1:passed', 'b\u0000r2:reserved'],
  );
});

test('failed reservations do not write global state', () => {
  const cluster = createQuotaCluster({
    quota: 2,
    windowMs: 100,
    reservationTtlMs: 30,
    nodes: ['a'],
  });

  assert.equal(cluster.reserve('a', 'r1').ok, true);
  assert.equal(cluster.reserve('a', 'r2').ok, true);
  cluster.reconcile();
  const before = cluster.globalRecords().length;

  for (let index = 0; index < 20; index += 1) {
    assert.equal(cluster.reserve('a', `failed-${index}`).ok, false);
  }
  cluster.reconcile();

  assert.equal(cluster.globalRecords().length, before);
  assert.equal(cluster.node('a').stats.failed, 20);
  assert.equal(cluster.node('a').stats.accepted, 2);
});

test('timeouts release local and global reservations', () => {
  const cluster = createQuotaCluster({
    quota: 2,
    windowMs: 100,
    reservationTtlMs: 10,
    nodes: ['a'],
  });

  cluster.reserve('a', 'r1');
  cluster.reconcile();
  assert.equal(cluster.globalRecords().length, 1);

  cluster.advance(10);
  const report = cluster.reconcile();
  assert.equal(report.timeouts, 1);
  assert.equal(cluster.globalRecords().length, 0);
  assert.equal(cluster.reserve('a', 'r2').ok, true);
  cluster.reconcile();

  const audit = cluster.audit();
  assert.equal(audit.ok, true);
  assert.equal(audit.nodes[0]?.released, 1);
  assert.equal(audit.nodes[0]?.accepted, 2);
});

test('reconciliation corrects drift inside the public bound', () => {
  const cluster = createQuotaCluster({
    quota: 4,
    windowMs: 100,
    reservationTtlMs: 40,
    maxClockDriftMs: 5,
    nodes: [
      { id: 'a', physicalSkewMs: 5 },
      { id: 'b', physicalSkewMs: -5 },
    ],
  });

  cluster.advance(25);
  const before = cluster.audit();
  assert.equal(before.ok, true);
  assert.equal(before.nodes.every((node) => node.withinDriftBound), true);

  const report = cluster.reconcile();
  assert.deepEqual(report.violations, []);
  assert.equal(cluster.audit().ok, true);
  assert.equal(cluster.node('a').clock.now(), cluster.referenceClock.now());
  assert.equal(cluster.node('b').clock.now(), cluster.referenceClock.now());
});

test('ingesting a node batch is idempotent', () => {
  const cluster = createQuotaCluster({
    quota: 2,
    windowMs: 50,
    reservationTtlMs: 20,
    nodes: ['a'],
  });

  assert.equal(cluster.reserve('a', 'r1').ok, true);
  const batch = cluster.node('a').drainEvents();
  assert.equal(batch.length, 1);

  assert.deepEqual(cluster.ingest('a', batch), {
    applied: 1,
    duplicates: 0,
    buffered: 0,
    violations: [],
  });
  assert.deepEqual(cluster.ingest('a', batch), {
    applied: 0,
    duplicates: 1,
    buffered: 0,
    violations: [],
  });
  assert.equal(cluster.globalRecords().length, 1);

  cluster.reconcile();
  assert.equal(cluster.audit().inSync, true);
  assert.equal(cluster.audit().ok, true);
});

test('out-of-order batches are buffered until the sequence is complete', () => {
  const cluster = createQuotaCluster({
    quota: 2,
    windowMs: 50,
    reservationTtlMs: 20,
    nodes: ['a'],
  });

  cluster.reserve('a', 'r1');
  cluster.commit('a', 'r1');
  const batch = cluster.node('a').drainEvents();
  assert.equal(batch.length, 2);

  const first = cluster.ingest('a', [batch[1] as (typeof batch)[number]]);
  assert.deepEqual(first, {
    applied: 0,
    duplicates: 0,
    buffered: 1,
    violations: [],
  });
  assert.equal(cluster.globalRecords().length, 0);

  const second = cluster.ingest('a', [batch[0] as (typeof batch)[number]]);
  assert.deepEqual(second, {
    applied: 2,
    duplicates: 0,
    buffered: 0,
    violations: [],
  });
  assert.equal(cluster.globalRecords().length, 1);
  assert.equal(cluster.globalRecords()[0]?.state, 'passed');
  assert.equal(cluster.audit().inSync, true);
});

test('a release after commit is rejected without touching the global ledger', () => {
  const cluster = createQuotaCluster({
    quota: 2,
    windowMs: 50,
    reservationTtlMs: 20,
    nodes: ['a'],
  });

  cluster.reserve('a', 'r1');
  cluster.commit('a', 'r1');
  cluster.reconcile();
  const before = cluster.globalRecords();
  assert.equal(before.length, 1);
  assert.equal(before[0]?.state, 'passed');

  const report = cluster.ingest('a', [
    {
      kind: 'release',
      nodeId: 'a',
      seq: cluster.node('a').pendingEvents + 3,
      reservationId: 'r1',
      at: 0,
      reason: 'explicit',
    },
  ]);
  assert.equal(report.applied, 0);
  assert.equal(report.violations.length, 1);
  assert.deepEqual(cluster.globalRecords(), before);
  assert.equal(cluster.audit().inSync, false);
});

test('compaction drops only resolved records outside the effective window', () => {
  const cluster = createQuotaCluster({
    quota: 2,
    windowMs: 10,
    reservationTtlMs: 5,
    maxClockDriftMs: 1,
    nodes: ['a'],
  });

  cluster.reserve('a', 'r1');
  cluster.commit('a', 'r1');
  cluster.reconcile();
  assert.equal(cluster.records()['a']?.length, 1);

  cluster.advance(12);
  assert.equal(cluster.compact(), 3);
  assert.equal(cluster.records()['a']?.length, 0);
  assert.equal(cluster.globalRecords().length, 0);
  assert.equal(cluster.audit().ok, true);
});

test('concurrent gateway calls are serialized by the local shard', async () => {
  const cluster = createQuotaCluster({
    quota: 3,
    windowMs: 100,
    reservationTtlMs: 30,
    nodes: ['a'],
  });

  const results = await Promise.all(
    Array.from({ length: 40 }, (_, index) =>
      Promise.resolve().then(() => cluster.reserve('a', `req-${index}`)),
    ),
  );
  assert.equal(results.filter((result) => result.ok).length, 3);
  assert.equal(results.filter((result) => !result.ok).length, 37);
  assert.equal(cluster.node('a').pendingEvents, 3);

  cluster.reconcile();
  assert.equal(cluster.globalRecords().length, 3);
  assert.equal(cluster.audit().ok, true);
  assert.equal(cluster.audit().inSync, true);
});

test('audit rejects clocks outside the public drift bound', () => {
  const cluster = createQuotaCluster({
    quota: 2,
    windowMs: 100,
    reservationTtlMs: 30,
    maxClockDriftMs: 5,
    nodes: ['a'],
  });

  cluster.setNodeClockSkew('a', 20);
  const sync = cluster.sync('a');
  assert.equal(sync.withinBound, false);

  const audit = cluster.audit();
  assert.equal(audit.ok, false);
  assert.equal(audit.nodes[0]?.withinDriftBound, false);
  assert.ok(
    audit.violations.some((violation) => violation.includes('clock drift')),
  );
});
