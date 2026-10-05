import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { CompactedLog } from "../src/compaction";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Event simulation: appends, acks, joins, deregistrations, compactions and
 * crashes are interleaved at random. After every compaction and every crash
 * recovery, the remaining log plus the snapshot must reconstruct the full
 * reference state for every live replica.
 */
function runSimulation(seed: number, steps: number): void {
  const dir = join(".test-tmp", `sim-${seed}`);
  rmSync(dir, { recursive: true, force: true });
  const rand = mulberry32(seed);
  let log = CompactedLog.open(dir);

  const model = new Map<string, string>(); // reference: every append applied in order
  const live = new Set<string>();
  let replicaSeq = 0;
  let valueSeq = 0;

  const checkAllLiveReplicasRecoverable = (): void => {
    const expected = Object.fromEntries(model);
    for (const id of live) {
      deepEqual(
        log.recoverReplica(id),
        expected,
        `seed ${seed}: remaining log cannot recover live replica ${id}`,
      );
    }
  };

  const checkFrontierInvariant = (): void => {
    for (const id of live) {
      ok(
        log.ackedOffset(id) >= log.baseOffset,
        `seed ${seed}: ack vector of ${id} dragged below reclaimed history`,
      );
    }
  };

  for (let step = 0; step < steps; step++) {
    const r = rand();
    if (r < 0.35) {
      const key = `k${Math.floor(rand() * 20)}`;
      const value = `v${valueSeq++}`;
      log.append(key, value);
      model.set(key, value);
    } else if (r < 0.55 && live.size > 0) {
      const ids = [...live];
      const id = ids[Math.floor(rand() * ids.length)]!;
      const span = log.nextOffset - log.baseOffset;
      log.ack(id, log.baseOffset + Math.floor(rand() * (span + 1)));
    } else if (r < 0.68) {
      const id = `r${replicaSeq++}`;
      const joinInfo = log.registerReplica(id);
      equal(
        joinInfo.fromOffset,
        log.baseOffset,
        `seed ${seed}: new replica must load the snapshot first`,
      );
      equal(joinInfo.snapshot.uptoOffset, log.baseOffset);
      live.add(id);
    } else if (r < 0.8 && live.size > 0) {
      const ids = [...live];
      const id = ids[Math.floor(rand() * ids.length)]!;
      log.deregister(id);
      live.delete(id);
    } else if (r < 0.92) {
      log.compact();
      checkAllLiveReplicasRecoverable();
    } else {
      log = CompactedLog.open(dir); // crash + recover from disk
      checkAllLiveReplicasRecoverable();
    }
    checkFrontierInvariant();
  }

  log.compact();
  checkAllLiveReplicasRecoverable();
  rmSync(dir, { recursive: true, force: true });
}

test("event simulation: remaining log recovers all live replicas", () => {
  for (const seed of [1, 7, 42, 1337, 20261005]) {
    runSimulation(seed, 600);
  }
});
