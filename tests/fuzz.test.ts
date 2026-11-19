import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, resetIds, runDifferential } from './harness.js';
import type { BatcherConfig, InputEvent } from '../src/protocol.js';

const fuzzConfig: BatcherConfig = {
  batchSize: 3,
  refreshTimeoutMs: 8,
  tenantQuotas: { t1: 3, t2: 5, t3: 2 },
  downstreamLatencyMs: 6,
};

/**
 * 固定种子随机生成混合事件流：时间单调推进，覆盖到达（含配额排队）、
 * flush、背压开关与时钟推进；期望完全由参考状态机产生并逐事件差分。
 */
function generate(seed: number, length: number): InputEvent[] {
  const rand = mulberry32(seed);
  const tenants = Object.keys(fuzzConfig.tenantQuotas);
  const events: InputEvent[] = [];
  let clock = 0;
  let requestSeq = 0;
  for (let i = 0; i < length; i += 1) {
    const roll = rand();
    if (roll < 0.62) {
      clock += rand() < 0.25 ? 3 : 1;
      requestSeq += 1;
      const tenantId =
        tenants[Math.floor(rand() * tenants.length)] ?? 't1';
      events.push({
        kind: 'arrival',
        arrival: {
          requestId: `seed${seed}-r${requestSeq}`,
          tenantId,
          at: clock,
        },
      });
    } else if (roll < 0.76) {
      clock += 1;
      const tenantId =
        tenants[Math.floor(rand() * tenants.length)] ?? 't1';
      events.push({ kind: 'flush', tenantId, at: clock });
    } else if (roll < 0.88) {
      clock += 1;
      events.push({ kind: 'backpressure', on: rand() < 0.5, at: clock });
    } else {
      clock += 1 + Math.floor(rand() * 6);
      events.push({ kind: 'advance', at: clock });
    }
  }
  return events;
}

test('固定种子随机流差分：种子 1/2/3 各 300 事件', () => {
  for (const seed of [1, 2, 3]) {
    resetIds();
    const events = generate(seed, 300);
    const { snapshots } = runDifferential(fuzzConfig, events);
    assert.equal(snapshots.length, events.length);
    const final = snapshots[snapshots.length - 1]!;
    assert.ok(final.batches.length > 0, `seed ${seed} 应产生批次`);
    const allClosed = final.batches
      .filter((batch) => batch.status !== 'completed')
      .every((batch) => batch.members.length <= fuzzConfig.batchSize);
    assert.ok(allClosed, `seed ${seed} 批次不得超过批大小`);
  }
});

test('随机流中所有拒绝原因均属于协议枚举', () => {
  resetIds();
  const events = generate(7, 200);
  const allowed = new Set(['backpressure', 'unknown-tenant', 'clock-rewind']);
  const { snapshots } = runDifferential(fuzzConfig, events);
  for (const snap of snapshots) {
    for (const rejection of snap.effects.rejected) {
      assert.ok(allowed.has(rejection.reason));
    }
  }
});

test('长随机流结束后推进足够久，所有批次最终完成且队列排空', () => {
  resetIds();
  const generated = generate(11, 250);
  const lastClock = generated.reduce(
    (max, event) =>
      Math.max(
        max,
        event.kind === 'arrival' ? event.arrival.at : event.at,
      ),
    0,
  );
  const events: InputEvent[] = [
    ...generated,
    { kind: 'backpressure', on: false, at: lastClock + 1 },
    { kind: 'advance', at: 10_000 },
  ];
  const { snapshots } = runDifferential(fuzzConfig, events);
  const final = snapshots[snapshots.length - 1]!;
  assert.equal(final.waitingQueue.length, 0);
  for (const tenant of Object.values(final.tenants)) {
    assert.equal(tenant.inFlight, 0);
    assert.equal(tenant.openBatchId, null);
    assert.equal(tenant.retainedBatchId, null);
    assert.equal(tenant.inFlightBatchIds.length, 0);
  }
  assert.ok(
    final.batches.every((batch) => batch.status === 'completed'),
  );
});
