import test from 'node:test';
import assert from 'node:assert/strict';
import { Harness } from './harness.js';

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  const value = values[Math.floor(random() * values.length)];
  if (value === undefined) {
    throw new Error('empty choice');
  }
  return value;
}

test('clock advancement interleaved with reconciliation conserves tokens', () => {
  const driftBound = 3;
  const nodeIds = ['a', 'b', 'c'] as const;
  const baseSkew = new Map<string, number>([
    ['a', 1],
    ['b', -1],
    ['c', 0],
  ]);

  for (let seed = 1; seed <= 120; seed += 1) {
    const random = mulberry32(seed);
    const harness = new Harness({
      quota: 6,
      windowMs: 20,
      reservationTtlMs: 12,
      maxClockDriftMs: driftBound,
      nodeIds,
      shardLimits: [2, 2, 2],
      physicalSkews: [1, -1, 0],
    });
    const rawOffset = new Map<string, number>(
      nodeIds.map((id) => [id, baseSkew.get(id) ?? 0]),
    );
    const syncedOffset = new Map<string, number>(rawOffset);

    for (let step = 0; step < 90; step += 1) {
      const roll = random();
      const nodeId = pick(random, nodeIds);
      try {
        if (roll < 0.34) {
          harness.reserve(nodeId);
        } else if (roll < 0.54) {
          harness.commit(nodeId);
        } else if (roll < 0.64) {
          harness.release(nodeId);
        } else if (roll < 0.72) {
          harness.advance(1 + Math.floor(random() * 6));
        } else if (roll < 0.82) {
          const current = rawOffset.get(nodeId) ?? 0;
          const synced = syncedOffset.get(nodeId) ?? 0;
          const delta = pick(random, [-2, -1, 1, 2]);
          const next = current + delta;
          if (
            Math.abs(next) <= driftBound &&
            Math.abs(next - synced) <= driftBound
          ) {
            harness.advanceNodeClock(nodeId, delta);
            rawOffset.set(nodeId, next);
          } else {
            harness.sync(nodeId);
            syncedOffset.set(nodeId, current);
            if (Math.abs(next) <= driftBound && Math.abs(delta) <= driftBound) {
              harness.advanceNodeClock(nodeId, delta);
              rawOffset.set(nodeId, next);
            }
          }
        } else if (roll < 0.9) {
          harness.sync(nodeId);
          syncedOffset.set(nodeId, rawOffset.get(nodeId) ?? 0);
        } else {
          harness.reconcile();
          for (const id of nodeIds) {
            syncedOffset.set(id, rawOffset.get(id) ?? 0);
          }
        }
      } catch (error) {
        throw new Error(
          `seed ${seed} step ${step}: ${(error as Error).message}`,
          { cause: error },
        );
      }

      const audit = harness.cluster.audit();
      for (const node of audit.nodes) {
        assert.equal(node.conserved, true, `seed ${seed} step ${step} ${node.id}`);
        assert.ok(
          node.maxWindowUsage <= node.shardLimit,
          `seed ${seed} step ${step} ${node.id} shard overflow`,
        );
        assert.ok(
          Math.abs(node.driftMs) <= driftBound,
          `seed ${seed} step ${step} ${node.id} drift ${node.driftMs}`,
        );
      }
      assert.ok(
        audit.globalMaxWindowUsage <= audit.quota,
        `seed ${seed} step ${step} global overflow`,
      );
    }

    harness.reconcile();
    const audit = harness.cluster.audit();
    assert.equal(audit.ok, true, `seed ${seed}: ${audit.violations.join('; ')}`);
    assert.equal(audit.inSync, true, `seed ${seed} not in sync`);
  }
});

test('drift guard is included in the effective window', () => {
  const harness = new Harness({
    quota: 2,
    windowMs: 10,
    reservationTtlMs: 100,
    maxClockDriftMs: 2,
    nodeIds: ['a'],
    shardLimits: [2],
  });

  assert.equal(harness.cluster.node('a').effectiveWindowMs, 14);
  assert.equal(harness.cluster.effectiveWindowMs, 14);
  harness.reserve('a');
  harness.reserve('a');
  harness.advance(10);
  harness.reserve('a');
  harness.reconcile();
});
