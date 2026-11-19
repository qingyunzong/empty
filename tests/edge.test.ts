import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  advance,
  arrival,
  backpressure,
  baseConfig,
  flush,
  resetIds,
  runDifferential,
} from './harness.js';

function last<T>(items: T[]): T {
  const item = items[items.length - 1];
  if (item === undefined) throw new Error('empty snapshot list');
  return item;
}

test('满批立即按 size 关闭并派发到下游', () => {
  resetIds();
  const { snapshots } = runDifferential(baseConfig, [
    arrival('alpha', 1),
    arrival('alpha', 2),
    arrival('alpha', 3),
  ]);
  const final = last(snapshots);
  const first = final.batches[0]!;
  assert.deepEqual(
    first.members.map((req) => req.requestId),
    ['r1', 'r2', 'r3'],
  );
  assert.equal(first.status, 'in-flight');
  assert.equal(first.closeReason, 'size');
  assert.equal(first.dispatchedAt, 3);
  assert.equal(final.tenants.alpha?.inFlight, 3);
  assert.equal(final.effects.closed[0]?.reason, 'size');
});

test('超时与满批同刻触发：先时间结算 timeout，再到达受理 size', () => {
  resetIds();
  const config = {
    ...baseConfig,
    batchSize: 5,
    refreshTimeoutMs: 9,
  };
  const { snapshots } = runDifferential(config, [
    arrival('alpha', 1),
    arrival('alpha', 2),
    arrival('alpha', 10),
  ]);
  const atTen = last(snapshots);
  assert.equal(atTen.batches.length, 2);
  const timedOutBatch = atTen.batches.find(
    (batch) => batch.batchId === 'alpha#1',
  )!;
  assert.equal(timedOutBatch.closeReason, 'timeout');
  assert.equal(timedOutBatch.status, 'in-flight');
  assert.deepEqual(
    timedOutBatch.members.map((req) => req.requestId),
    ['r1', 'r2'],
  );
  assert.equal(atTen.tenants.alpha?.openBatchId, 'alpha#2');
  assert.deepEqual(
    atTen.batches.find((batch) => batch.batchId === 'alpha#2')!
      .members.map((req) => req.requestId),
    ['r3'],
  );
  const effects = atTen.effects;
  assert.deepEqual(
    effects.closed.map((item) => item.reason),
    ['timeout'],
  );
  assert.deepEqual(
    effects.accepted.map((req) => req.requestId),
    ['r3'],
  );
});

test('超时边界同刻：到达时刻恰为 deadline 时先结算 timeout 再受理新批', () => {
  resetIds();
  const config = { ...baseConfig, batchSize: 5 };
  const { snapshots } = runDifferential(config, [
    arrival('alpha', 0),
    arrival('alpha', 0),
    arrival('alpha', 10),
  ]);
  const final = last(snapshots);
  assert.equal(final.batches.length, 2);
  assert.equal(
    final.batches.find((batch) => batch.batchId === 'alpha#1')!
      .closeReason,
    'timeout',
  );
  assert.equal(final.effects.closed[0]?.reason, 'timeout');
  assert.equal(final.tenants.alpha?.openBatchId, 'alpha#2');
});

test('配额恰满：第 quota 个接受、第 quota+1 个排队而非丢弃', () => {
  resetIds();
  const config = {
    ...baseConfig,
    batchSize: 10,
    refreshTimeoutMs: 1_000,
    tenantQuotas: { alpha: 4, bravo: 2 },
  };
  const { snapshots } = runDifferential(config, [
    arrival('bravo', 1),
    arrival('bravo', 2),
    arrival('bravo', 3),
  ]);
  const final = last(snapshots);
  assert.equal(final.tenants.bravo?.inFlight, 2);
  assert.deepEqual(
    final.tenants.bravo?.waiting.map((req) => req.requestId),
    ['r3'],
  );
  assert.equal(final.effects.rejected.length, 0);
  assert.deepEqual(
    final.waitingQueue.map((req) => req.requestId),
    ['r3'],
  );
});

test('完成释放配额后严格 FIFO 泵送，队首租户阻塞时不插队', () => {
  resetIds();
  const config = {
    ...baseConfig,
    batchSize: 10,
    refreshTimeoutMs: 1_000,
    downstreamLatencyMs: 5,
    tenantQuotas: { alpha: 2, bravo: 2 },
  };
  const { snapshots } = runDifferential(config, [
    arrival('bravo', 1),
    arrival('bravo', 2),
    flush('bravo', 2),
    arrival('bravo', 3),
    arrival('bravo', 4),
    arrival('alpha', 5),
    arrival('alpha', 6),
    arrival('alpha', 7),
    advance(8),
  ]);
  const beforeSettle = snapshots[6]!;
  assert.equal(beforeSettle.tenants.alpha?.inFlight, 2);
  assert.deepEqual(
    beforeSettle.waitingQueue.map((req) => req.requestId),
    ['r3', 'r4'],
  );
  assert.deepEqual(
    beforeSettle.effects.completed.map((item) => item.batchId),
    [],
  );
  const afterCompletion = snapshots[7]!;
  assert.deepEqual(
    afterCompletion.waitingQueue.map((req) => req.requestId),
    ['r7'],
  );
  assert.equal(
    afterCompletion.effects.completed[0]?.batchId,
    'bravo#1',
  );
  assert.deepEqual(
    afterCompletion.effects.accepted.map((req) => req.requestId),
    ['r3', 'r4'],
  );
  assert.equal(afterCompletion.tenants.bravo?.inFlight, 2);
  assert.equal(afterCompletion.tenants.alpha?.inFlight, 2);
  assert.deepEqual(
    afterCompletion.batches
      .find((batch) => batch.batchId === 'bravo#2')
      ?.members.map((req) => req.requestId),
    ['r3', 'r4'],
  );
});

test('超时边界：deadline-1 不关闭，deadline 关闭', () => {
  resetIds();
  const { snapshots } = runDifferential(baseConfig, [
    arrival('alpha', 0),
    advance(9),
  ]);
  assert.equal(snapshots[1]!.batches[0]?.status, 'open');
  assert.equal(snapshots[1]!.effects.closed.length, 0);
  resetIds();
  const atDeadline = last(
    runDifferential(baseConfig, [
      arrival('alpha', 0),
      advance(10),
    ]).snapshots,
  );
  assert.equal(atDeadline.batches[0]?.status, 'in-flight');
  assert.equal(atDeadline.batches[0]?.closeReason, 'timeout');
});

test('空批 flush 边界：无 open 批次与空 open 批次均为 noop', () => {
  resetIds();
  const { snapshots } = runDifferential(baseConfig, [
    flush('alpha', 1),
    arrival('alpha', 2),
    flush('alpha', 3),
    flush('alpha', 4),
  ]);
  assert.equal(snapshots[0]!.effects.flushNoops[0]?.kind, 'no-open-batch');
  const final = last(snapshots);
  assert.equal(final.effects.flushNoops[0]?.kind, 'no-open-batch');
  assert.equal(final.batches.length, 1);
  assert.equal(final.batches[0]?.closeReason, 'flush');
});

test('背压期间到达被拒、flush 整批保留，解除后重派并恢复泵送', () => {
  resetIds();
  const config = { ...baseConfig, batchSize: 10 };
  const events = [
    arrival('alpha', 1),
    arrival('alpha', 2),
    backpressure(true, 3),
    arrival('alpha', 4),
    flush('alpha', 5),
    backpressure(false, 6),
  ];
  const { snapshots } = runDifferential(config, events);
  assert.equal(snapshots[3]!.effects.rejected[0]?.reason, 'backpressure');
  const retainedSnap = snapshots[4]!;
  assert.equal(retainedSnap.batches[0]?.status, 'retained');
  assert.equal(
    retainedSnap.batches[0]?.closeReason,
    'flush',
  );
  assert.equal(retainedSnap.effects.closed[0]?.disposition, 'retained');
  const recovered = last(snapshots);
  assert.equal(recovered.batches[0]?.status, 'in-flight');
  assert.equal(recovered.effects.retainedDispatched.length, 1);
  assert.equal(
    recovered.effects.retainedDispatched[0]?.batchId,
    'alpha#1',
  );
  assert.equal(recovered.backpressure, false);
});

test('未知租户拒绝、时钟回退到达拒绝且不分配序号', () => {
  resetIds();
  const { snapshots } = runDifferential(baseConfig, [
    arrival('ghost', 1),
    arrival('alpha', 5),
    arrival('alpha', 2),
  ]);
  assert.equal(
    snapshots[0]!.effects.rejected[0]?.reason,
    'unknown-tenant',
  );
  const rewind = last(snapshots);
  assert.equal(rewind.effects.rejected[0]?.reason, 'clock-rewind');
  assert.equal(rewind.effects.accepted.length, 0);
  assert.equal(rewind.now, 5);
});

test('同租户保序、跨租户按 (时间, 租户字典序, 序号) 交错', () => {
  resetIds();
  const config = {
    ...baseConfig,
    batchSize: 10,
    refreshTimeoutMs: 1_000,
    tenantQuotas: { alpha: 5, bravo: 5 },
  };
  const { snapshots } = runDifferential(config, [
    arrival('bravo', 5),
    arrival('alpha', 5),
    arrival('bravo', 5),
    arrival('alpha', 6),
  ]);
  const final = last(snapshots);
  assert.equal(final.waitingQueue.length, 0);
  assert.deepEqual(
    final.batches
      .find((batch) => batch.tenantId === 'alpha')
      ?.members.map((req) => req.requestId),
    ['r2', 'r4'],
  );
  assert.deepEqual(
    final.batches
      .find((batch) => batch.tenantId === 'bravo')
      ?.members.map((req) => req.requestId),
    ['r1', 'r3'],
  );
  const ordered = [...final.batches]
    .flatMap((batch) => batch.members)
    .filter((req) => req.at === 5)
    .map((req) => req.tenantId);
  assert.deepEqual(ordered, ['alpha', 'bravo', 'bravo']);
});
