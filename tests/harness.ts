import assert from 'node:assert/strict';
import { Batcher } from '../src/batcher.js';
import {
  initOracle,
  oracleStep,
} from '../oracle/oracle.js';
import type {
  BatcherConfig,
  InputEvent,
  StateSnapshot,
} from '../src/protocol.js';

/**
 * 与两台实现都无关的结构性不变量：即使双机同错也能被捕获。
 */
function assertInvariants(snapshot: StateSnapshot, index: number): void {
  const seenRequests = new Set<string>();
  for (const batch of snapshot.batches) {
    for (const member of batch.members) {
      assert.ok(
        !seenRequests.has(member.requestId),
        `event #${index}: request ${member.requestId} 出现在多个批次位置`,
      );
      seenRequests.add(member.requestId);
    }
  }
  for (const waiting of snapshot.waitingQueue) {
    assert.ok(
      !seenRequests.has(waiting.requestId),
      `event #${index}: ${waiting.requestId} 同时在批次与等待队列`,
    );
    seenRequests.add(waiting.requestId);
  }
  for (const [tenantId, tenant] of Object.entries(snapshot.tenants)) {
    assert.ok(
      tenant.inFlight <= tenant.quota,
      `event #${index}: 租户 ${tenantId} 在途 ${tenant.inFlight} 超过配额 ${tenant.quota}`,
    );
    assert.ok(
      tenant.inFlight >= 0,
      `event #${index}: 租户 ${tenantId} 在途为负`,
    );
    const retainedCount = Object.values(snapshot.batches).filter(
      (batch) =>
        batch.tenantId === tenantId && batch.status === 'retained',
    ).length;
    assert.ok(
      retainedCount <= 1,
      `event #${index}: 租户 ${tenantId} 存在多个 retained 批次`,
    );
  }
  const ordered: Array<[number, string, number]> = snapshot.waitingQueue.map((req) => [
    req.at,
    req.tenantId,
    req.seq,
  ]);
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1]!;
    const curr = ordered[i]!;
    const cmp =
      prev[0] - curr[0] ||
      String(prev[1]).localeCompare(String(curr[1])) ||
      prev[2] - curr[2];
    assert.ok(
      cmp <= 0,
      `event #${index}: 等待队列未按 (at, tenant, seq) 排序`,
    );
  }
}

/** 固定种子的确定性 PRNG（mulberry32），保证随机事件流可复现。 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DiffRun {
  snapshots: StateSnapshot[];
}

/**
 * 差分驱动：被测库与参考机消费同一条事件流，逐事件全量快照 deepStrictEqual。
 * 期望快照只来自参考机，被测库只提供实际输出。
 */
export function runDifferential(
  config: BatcherConfig,
  events: InputEvent[],
): DiffRun {
  const sut = new Batcher(config);
  const oracle = initOracle(config);
  const snapshots: StateSnapshot[] = [];
  events.forEach((event, index) => {
    const actual = sut.handle(event);
    const expected = oracleStep(oracle, event, config);
    assert.deepStrictEqual(
      actual,
      expected,
      `snapshot divergence after event #${index} (${event.kind})`,
    );
    assertInvariants(actual, index);
    snapshots.push(actual);
  });
  return { snapshots };
}

export const baseConfig: BatcherConfig = {
  batchSize: 3,
  refreshTimeoutMs: 10,
  tenantQuotas: { alpha: 4, bravo: 2 },
  downstreamLatencyMs: 7,
};

let requestCounter = 0;
export function arrival(
  tenantId: string,
  at: number,
): Extract<InputEvent, { kind: 'arrival' }> {
  requestCounter += 1;
  return {
    kind: 'arrival',
    arrival: {
      requestId: `r${requestCounter}`,
      tenantId,
      at,
    },
  };
}

export function flush(tenantId: string, at: number): InputEvent {
  return { kind: 'flush', tenantId, at };
}

export function backpressure(on: boolean, at: number): InputEvent {
  return { kind: 'backpressure', on, at };
}

export function advance(at: number): InputEvent {
  return { kind: 'advance', at };
}

export function resetIds(): void {
  requestCounter = 0;
}
