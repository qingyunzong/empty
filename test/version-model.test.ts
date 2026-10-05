import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Database,
  Transaction,
  CommitConflictError,
  type Value,
} from "../src/index.js";

// Deterministic PRNG so the randomized workload is reproducible.
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

const TABLES = ["t1", "t2", "t3"] as const;
const KEYS = Array.from({ length: 12 }, (_, i) => "k" + i);

interface ReadObservation {
  startTs: number;
  table: string;
  key: string;
  value: Value | undefined;
  // The transaction's own staged write for this key at read time, if any
  // (read-your-own-writes overlays the snapshot). Absent = read hit the
  // committed snapshot directly.
  staged: { found: boolean; value: Value | null };
}

test("barrier history and full version model cross-check (randomized)", () => {
  const rand = mulberry32(20261005);
  const db = new Database();
  for (const t of TABLES) db.createTable(t);

  const observations: ReadObservation[] = [];
  const active: Transaction[] = [];
  const stagedMirror = new Map<Transaction, Map<string, Value | null>>();
  let committed = 0;
  let conflicts = 0;

  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const mkey = (table: string, key: string) => table + "/" + key;

  for (let step = 0; step < 4000; step++) {
    const action = rand();
    if (active.length === 0 || action < 0.25) {
      const txn = db.begin();
      active.push(txn);
      stagedMirror.set(txn, new Map());
    } else if (action < 0.55) {
      const txn = pick(active);
      const table = pick(TABLES);
      const key = pick(KEYS);
      const staged = stagedMirror.get(txn)!.get(mkey(table, key));
      const stagedFound = stagedMirror.get(txn)!.has(mkey(table, key));
      const value = txn.get(table, key);
      observations.push({
        startTs: txn.startTs,
        table,
        key,
        value,
        staged: { found: stagedFound, value: staged === undefined ? null : staged },
      });
    } else if (action < 0.8) {
      const txn = pick(active);
      const table = pick(TABLES);
      const key = pick(KEYS);
      if (rand() < 0.15) {
        txn.delete(table, key);
        stagedMirror.get(txn)!.set(mkey(table, key), null);
      } else {
        txn.set(table, key, "v" + step);
        stagedMirror.get(txn)!.set(mkey(table, key), "v" + step);
      }
    } else if (action < 0.9) {
      const txn = active.splice(Math.floor(rand() * active.length), 1)[0]!;
      txn.rollback();
      stagedMirror.delete(txn);
    } else {
      const txn = active.splice(Math.floor(rand() * active.length), 1)[0]!;
      stagedMirror.delete(txn);
      try {
        txn.commit();
        committed++;
      } catch (err) {
        assert.ok(err instanceof CommitConflictError);
        conflicts++;
      }
    }
  }
  for (const txn of active.splice(0)) {
    if (txn.isActive) {
      stagedMirror.delete(txn);
      try {
        txn.commit();
        committed++;
      } catch (err) {
        assert.ok(err instanceof CommitConflictError);
        conflicts++;
      }
    }
  }
  assert.ok(committed > 100, "workload too thin: " + committed + " commits");
  assert.ok(conflicts > 0, "workload should exercise real conflicts");
  assert.ok(observations.length > 500, "need a meaningful read sample");

  // Barrier history: the commit log is the global commit barrier.
  const log = db.commitLog();
  assert.equal(log.length, committed);
  for (let i = 1; i < log.length; i++) {
    assert.ok(
      log[i]!.commitTs > log[i - 1]!.commitTs,
      "commit timestamps must be strictly increasing",
    );
    assert.ok(
      log[i]!.startTs < log[i]!.commitTs,
      "a transaction always commits after its snapshot",
    );
  }

  // Rebuild the complete version model purely from the commit log.
  const model = new Map<string, Array<{ commitTs: number; value: Value | null }>>();
  const modelKey = (table: string, key: string) => table + "/" + key;
  for (const record of log) {
    for (const w of record.writes) {
      const mk = modelKey(w.table, w.key);
      let chain = model.get(mk);
      if (chain === undefined) {
        chain = [];
        model.set(mk, chain);
      }
      chain.push({ commitTs: record.commitTs, value: w.value });
    }
  }

  // Write-write barrier per key: for successive committed versions of the
  // same key, the later writer's snapshot must be >= the previous version's
  // commitTs. This is exactly first-committer-wins, verified from history.
  const commitByTs = new Map(log.map((r) => [r.commitTs, r]));
  for (const [mk, chain] of model) {
    for (let i = 1; i < chain.length; i++) {
      assert.ok(chain[i]!.commitTs > chain[i - 1]!.commitTs, mk + ": chain order");
      const writer = commitByTs.get(chain[i]!.commitTs)!;
      assert.ok(
        writer.startTs >= chain[i - 1]!.commitTs,
        mk + ": writer@" + writer.commitTs + " started at " + writer.startTs +
          " but previous version committed at " + chain[i - 1]!.commitTs,
      );
    }
  }

  // The model rebuilt from the log must equal the store's actual chains.
  for (const [mk, chain] of model) {
    const parts = mk.split("/");
    const table = parts[0]!;
    const key = parts[1]!;
    assert.deepEqual([...db.versionHistory(table, key)], chain);
  }

  // Full version-model check of every observed read: each read must equal
  // the newest version with commitTs <= snapshot, i.e. no read ever crosses
  // the commit barrier of its own snapshot.
  const lookup = (table: string, key: string, snapshotTs: number): Value | undefined => {
    const chain = model.get(modelKey(table, key));
    if (chain === undefined) return undefined;
    let result: Value | undefined;
    for (const v of chain) {
      if (v.commitTs <= snapshotTs) result = v.value === null ? undefined : v.value;
      else break;
    }
    return result;
  };
  for (const obs of observations) {
    // Read-your-own-writes: a staged write shadows the snapshot.
    if (obs.staged.found) {
      const expected = obs.staged.value === null ? undefined : obs.staged.value;
      assert.equal(
        obs.value,
        expected,
        "staged read of " + obs.table + "/" + obs.key,
      );
      continue;
    }
    assert.equal(
      obs.value,
      lookup(obs.table, obs.key, obs.startTs),
      "read of " + obs.table + "/" + obs.key + " at snapshot " + obs.startTs,
    );
  }

  // Conflict evidence is always backed by the barrier history: re-run a
  // deterministic conflicting pair and verify the evidence points at a
  // real entry of the commit log.
  const t1 = db.begin();
  const t2 = db.begin();
  t1.set("t1", "k0", "final-1");
  t2.set("t1", "k0", "final-2");
  const winner = t1.commit();
  try {
    t2.commit();
    assert.fail("must conflict");
  } catch (err) {
    if (!(err instanceof CommitConflictError)) throw err;
    const ev = err.conflicts[0]!;
    const winningRecord = log.find((r) => r.commitTs === ev.conflictingCommitTs);
    assert.ok(winningRecord, "evidence must reference a real commit-log entry");
    assert.equal(winner.commitTs, ev.conflictingCommitTs);
    assert.ok(
      winningRecord.writes.some((w) => w.table === ev.table && w.key === ev.key),
      "evidence must name a key the winning transaction actually wrote",
    );
    assert.ok(ev.attemptedCommitTs > ev.conflictingCommitTs);
  }
});
