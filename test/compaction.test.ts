import { test } from "node:test";
import { deepEqual, equal, throws } from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { CompactedLog } from "../src/compaction";

function freshDir(name: string): string {
  const dir = join(".test-tmp", name);
  rmSync(dir, { recursive: true, force: true });
  return dir;
}

test("compaction deletes only the fully acknowledged prefix", () => {
  const log = CompactedLog.open(freshDir("prefix"));
  for (let i = 0; i < 10; i++) log.append(`k${i}`, `v${i}`);
  log.registerReplica("r1");
  log.registerReplica("r2");
  log.ack("r1", 4);
  log.ack("r2", 7);

  const frontier = log.compact();
  equal(frontier, 4);
  equal(log.baseOffset, 4);
  deepEqual(log.snapshot().state, { k0: "v0", k1: "v1", k2: "v2", k3: "v3" });

  log.ack("r1", 10);
  log.compact();
  equal(log.baseOffset, 7, "frontier is pinned by the slowest live replica");
});

test("deregistration is persisted in the epoch record across crashes", () => {
  const dir = freshDir("deregister");
  let log = CompactedLog.open(dir);
  log.append("a", "1");
  log.registerReplica("r1");
  log.registerReplica("r2");
  log.deregister("r2");
  const epochAfterDeregister = log.epoch;
  const deregisteredAt = log.deregisteredAtEpoch("r2");

  log = CompactedLog.open(dir); // simulate crash + restart
  equal(log.isLive("r2"), false, "deregistered replica must not resurrect");
  equal(log.isLive("r1"), true);
  equal(log.epoch, epochAfterDeregister);
  equal(log.deregisteredAtEpoch("r2"), deregisteredAt);
  throws(() => log.ack("r2", 1), "acks from a deregistered replica are rejected");
});

test("a new replica joins via snapshot and cannot drag back reclaimed history", () => {
  const log = CompactedLog.open(freshDir("snapshot-first"));
  for (let i = 0; i < 10; i++) log.append(`k${i}`, `v${i}`);
  log.registerReplica("r1");
  log.ack("r1", 10);
  log.compact();
  equal(log.baseOffset, 10);

  const join = log.registerReplica("r2");
  equal(join.fromOffset, 10, "new replica must start from the snapshot frontier");
  equal(join.snapshot.uptoOffset, 10);
  equal(log.ackedOffset("r2"), 10, "ack vector starts at the frontier, never at zero");

  throws(() => log.ack("r2", 0), "zero vector below the frontier is rejected");
  throws(() => log.ack("r2", 5), "ack below reclaimed history is rejected");

  log.append("k10", "v10");
  log.ack("r1", 11);
  log.compact();
  equal(log.baseOffset, 10, "fresh replica pins the frontier at the snapshot, not at zero");
  log.ack("r2", 11);
  log.compact();
  equal(log.baseOffset, 11);
});
