import { test } from "node:test";
import { strictEqual, deepStrictEqual, throws } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  LogCompactionSystem,
  ZeroVectorRegistrationError,
  StaleSnapshotError,
} from "../src/index.js";

type KvState = Record<string, number>;
interface KvOp {
  key: string;
  value: number;
}

const kvReducer = (state: KvState, op: KvOp): KvState => ({ ...state, [op.key]: op.value });

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "systemtest-"));
}

function expectedState(n: number): KvState {
  let state: KvState = {};
  for (let i = 1; i <= n; i++) state = kvReducer(state, { key: `k${i}`, value: i });
  return state;
}

test("compaction reclaims exactly the prefix confirmed by all live replicas", () => {
  const dir = tmpdir();
  const sys = LogCompactionSystem.open<KvState, KvOp>(dir, kvReducer, {});
  sys.registerReplica("r1");
  sys.registerReplica("r2");
  for (let i = 1; i <= 10; i++) sys.append({ key: `k${i}`, value: i });

  sys.ackReplica("r1", 6);
  sys.ackReplica("r2", 4);
  strictEqual(sys.compact(), 4);
  strictEqual(sys.log.startLsn, 5);
  strictEqual(sys.log.lastLsn, 10);
  deepStrictEqual(
    sys.log.entriesAfter(0).map((e) => e.lsn),
    [5, 6, 7, 8, 9, 10],
  );

  // Deregistering the laggard advances the horizon on the next pass.
  sys.deregisterReplica("r2");
  strictEqual(sys.compact(), 2);
  strictEqual(sys.log.startLsn, 7);
});

test("new replicas must load a snapshot; zero vector cannot drag back reclaimed history", () => {
  const dir = tmpdir();
  const sys = LogCompactionSystem.open<KvState, KvOp>(dir, kvReducer, {});
  sys.registerReplica("r1");
  for (let i = 1; i <= 10; i++) sys.append({ key: `k${i}`, value: i });
  sys.ackReplica("r1", 10);
  sys.compact();
  strictEqual(sys.log.startLsn, 11);

  // Zero-vector join after reclamation is rejected.
  throws(() => sys.registerReplica("r2"), ZeroVectorRegistrationError);
  // Stale / unknown snapshots are rejected too.
  throws(() => sys.registerReplica("r2", { lsn: 3 }), StaleSnapshotError);
  throws(() => sys.registerReplica("r2", { lsn: 999 }), StaleSnapshotError);

  // Snapshot-first join works and starts the ack vector at the snapshot LSN.
  const snap = sys.takeSnapshot();
  sys.registerReplica("r2", snap);
  strictEqual(sys.registry.ackOf("r2"), 10);
  deepStrictEqual(sys.recoverReplica("r2").state, expectedState(10));
});

test("deregistration and log bounds survive crash-recovery; live replicas stay recoverable", () => {
  const dir = tmpdir();
  let sys = LogCompactionSystem.open<KvState, KvOp>(dir, kvReducer, {});
  sys.registerReplica("r1");
  sys.registerReplica("r2");
  for (let i = 1; i <= 8; i++) sys.append({ key: `k${i}`, value: i });
  sys.ackReplica("r1", 5);
  sys.ackReplica("r2", 8);
  sys.deregisterReplica("r2");
  sys.compact();
  strictEqual(sys.log.startLsn, 6);

  // Simulate a crash: discard the instance, reopen from disk.
  sys = LogCompactionSystem.open<KvState, KvOp>(dir, kvReducer, {});
  strictEqual(sys.registry.isMember("r2"), false);
  strictEqual(sys.registry.isMember("r1"), true);
  strictEqual(sys.registry.ackOf("r1"), 5);
  strictEqual(sys.log.startLsn, 6);
  strictEqual(sys.log.lastLsn, 8);
  deepStrictEqual(sys.headState(), expectedState(8));

  // The remaining log still recovers every live replica.
  const recovered = sys.recoverReplica("r1");
  deepStrictEqual(recovered.state, expectedState(8));
  strictEqual(recovered.replayedTo, 8);

  // Appends continue with fresh LSNs after recovery.
  strictEqual(sys.append({ key: "k9", value: 9 }), 9);
  sys.ackReplica("r1", 9);
  strictEqual(sys.compact(), 4); // reclaims retained LSNs 6..9
  strictEqual(sys.log.startLsn, 10);
  deepStrictEqual(sys.recoverReplica("r1").state, expectedState(9));
});
