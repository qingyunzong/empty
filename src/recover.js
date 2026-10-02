// Crash recovery with provable results:
//   wal-append      -> truncate torn tail, replay WAL
//   snapshot-rename -> ignore (delete) the half snapshot
//   index-update    -> rebuild index from state (derived, never double counts)
// Every WAL record carries the post-op state hash; recovery recomputes the
// chain and any divergence is exit 23. Checksum failure mid-WAL is exit 22.
import { apply, initialState, buildIndex, MachineError, EXIT } from './machine.js';
import { hashState } from './hash.js';
import {
  readWal, truncateWal, readSnapshot, discardHalfSnapshot, readIndex, writeIndex,
} from './store.js';

export function replay(records, base = initialState()) {
  const state = base;
  for (const rec of records) {
    apply(state, rec.op);
    const actual = hashState(state);
    if (actual !== rec.hash) {
      throw new MachineError(
        EXIT.HASH_MISMATCH,
        `state hash mismatch after record ${rec.seq}: expected ${rec.hash}, got ${actual}`,
      );
    }
  }
  return state;
}

export function recover(dir) {
  const report = { faults: [], actions: [] };

  // Fault point 2: half snapshot (tmp never renamed) is ignored.
  const { snapshot, halfSnapshot } = readSnapshot(dir);
  if (halfSnapshot) {
    discardHalfSnapshot(dir);
    report.faults.push('snapshot-rename');
    report.actions.push('ignored half snapshot (snapshot.json.tmp discarded)');
  }
  if (snapshot && hashState(snapshot.state) !== snapshot.hash) {
    throw new MachineError(EXIT.HASH_MISMATCH, 'snapshot hash mismatch');
  }

  // Fault point 1: torn WAL tail -> truncate, then replay.
  const wal = readWal(dir); // throws exit 22 on mid-file checksum failure
  if (wal.torn) {
    truncateWal(dir, wal.records);
    report.faults.push('wal-append');
    report.actions.push(`truncated torn WAL tail at record ${wal.records.length + 1}; replayed WAL`);
  }

  // Full replay from genesis, verifying the hash chain (exit 23 on divergence).
  const state = replay(wal.records);

  // Cross-check: snapshot + tail replay must converge to the same hash.
  if (snapshot) {
    const tail = wal.records.filter((r) => r.seq > snapshot.seq);
    const fromSnap = replay(tail, snapshot.state);
    if (hashState(fromSnap) !== hashState(state)) {
      throw new MachineError(EXIT.HASH_MISMATCH, 'snapshot+WAL replay diverges from full replay');
    }
  }

  // Fault point 3: index is derived; rebuild and compare (no double counting).
  const rebuilt = buildIndex(state);
  const onDisk = readIndex(dir);
  if (JSON.stringify(onDisk) !== JSON.stringify(rebuilt)) {
    writeIndex(dir, rebuilt);
    if (onDisk && onDisk.seq === rebuilt.seq) {
      // Same seq but wrong content: the index write itself was the fault.
      report.faults.push('index-update');
      report.actions.push('rebuilt corrupt index from state (no double count)');
    } else if (onDisk) {
      report.actions.push('rebuilt stale index from state');
    }
  }

  report.hash = hashState(state);
  report.seq = state.seq;
  return { state, report, index: rebuilt };
}

// Strict load for normal mutations: refuse to run on top of crash debris.
export function loadStrict(dir) {
  const { snapshot, halfSnapshot } = readSnapshot(dir);
  if (halfSnapshot) {
    throw new MachineError(1, 'half snapshot detected; run `crash-recover` first');
  }
  const wal = readWal(dir);
  if (wal.torn) {
    throw new MachineError(1, 'torn WAL tail detected; run `crash-recover` first');
  }
  const state = replay(wal.records);
  if (snapshot && hashState(snapshot.state) !== hashState(replay(
    wal.records.filter((r) => r.seq <= snapshot.seq),
  ))) {
    throw new MachineError(EXIT.HASH_MISMATCH, 'snapshot does not match WAL prefix');
  }
  return state;
}
