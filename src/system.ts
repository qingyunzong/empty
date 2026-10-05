import * as path from "node:path";
import { PersistentLog } from "./log.js";
import { ReplicaRegistry } from "./registry.js";
import { SnapshotStore, type Snapshot } from "./snapshot.js";
import { compactionHorizon } from "./compactor.js";

export type Reducer<S, V> = (state: S, value: V) => S;

export class ZeroVectorRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZeroVectorRegistrationError";
  }
}

export class StaleSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleSnapshotError";
  }
}

export interface RecoveredState<S> {
  state: S;
  /** LSN of the snapshot the recovery started from (0 = initial state). */
  baseLsn: number;
  /** LSN the replay reached (always the current log tail). */
  replayedTo: number;
}

/**
 * Log compaction system.
 *
 * - Compaction deletes the log prefix confirmed by EVERY live replica
 *   (min of the ack vector); deregistered replicas stop holding it back
 *   because deregistration is persisted in the epoch log.
 * - A new replica must join from a snapshot taken at or after the
 *   compaction frontier. Joining with a zero ack vector after history was
 *   reclaimed is rejected, so reclaimed history can never be dragged back.
 * - Every live replica remains recoverable from the remaining log:
 *   `compact()` snapshots the state at the horizon before truncating, and
 *   `recoverReplica` replays snapshot + retained suffix.
 */
export class LogCompactionSystem<S, V> {
  readonly log: PersistentLog<V>;
  readonly registry: ReplicaRegistry;
  readonly snapshots: SnapshotStore<S>;
  private head!: S;

  private constructor(
    private readonly reducer: Reducer<S, V>,
    private readonly initialState: S,
    dir: string,
  ) {
    this.log = PersistentLog.open<V>(path.join(dir, "log"));
    this.registry = ReplicaRegistry.open(path.join(dir, "registry"));
    this.snapshots = SnapshotStore.open<S>(path.join(dir, "snapshots"));
  }

  static open<S, V>(
    dir: string,
    reducer: Reducer<S, V>,
    initialState: S,
  ): LogCompactionSystem<S, V> {
    const sys = new LogCompactionSystem<S, V>(reducer, initialState, dir);
    sys.head = sys.rebuildState(sys.log.lastLsn);
    return sys;
  }

  /** Current materialized state at the log tail (defensive copy). */
  headState(): S {
    return structuredClone(this.head);
  }

  append(value: V): number {
    const entry = this.log.append(value);
    this.head = this.reducer(this.head, value);
    return entry.lsn;
  }

  /** Persist a snapshot of the current state; handle used for replica joins. */
  takeSnapshot(): Snapshot {
    return this.snapshots.save(this.log.lastLsn, this.head);
  }

  /**
   * Register a replica. Without a snapshot this is only allowed while the
   * full history is still present; once a prefix has been reclaimed a zero
   * ack vector would drag the compaction frontier back over reclaimed
   * history, so it is rejected.
   */
  registerReplica(replicaId: string, snapshot?: Snapshot): void {
    if (snapshot !== undefined) {
      if (!this.snapshots.has(snapshot.lsn)) {
        throw new StaleSnapshotError(`snapshot@${snapshot.lsn} does not exist`);
      }
      if (snapshot.lsn < this.log.startLsn - 1) {
        throw new StaleSnapshotError(
          `snapshot@${snapshot.lsn} predates reclaimed history (log starts at LSN ${this.log.startLsn})`,
        );
      }
      if (snapshot.lsn > this.log.lastLsn) {
        throw new StaleSnapshotError(
          `snapshot@${snapshot.lsn} is ahead of the log tail (LSN ${this.log.lastLsn})`,
        );
      }
      this.registry.register(replicaId, snapshot.lsn);
      return;
    }
    if (this.log.startLsn > 1) {
      throw new ZeroVectorRegistrationError(
        `replica "${replicaId}" must join from a snapshot: a zero ack vector ` +
          `would drag back history already reclaimed (log starts at LSN ${this.log.startLsn})`,
      );
    }
    this.registry.register(replicaId, 0);
  }

  /** Persistently remove a replica from the ack vector (epoch-logged). */
  deregisterReplica(replicaId: string): void {
    this.registry.deregister(replicaId);
  }

  ackReplica(replicaId: string, lsn: number): void {
    if (lsn > this.log.lastLsn) {
      throw new Error(`ack@${lsn} is ahead of the log tail (LSN ${this.log.lastLsn})`);
    }
    this.registry.ack(replicaId, lsn);
  }

  /**
   * Reclaim the prefix confirmed by every live replica. A snapshot at the
   * horizon is persisted first so every live replica keeps a recovery base.
   * Returns the number of entries reclaimed.
   */
  compact(): number {
    const horizon = Math.min(
      compactionHorizon(this.registry.ackVector().values()),
      this.log.lastLsn,
    );
    if (horizon < this.log.startLsn) return 0;
    if (!this.snapshots.has(horizon)) {
      this.snapshots.save(horizon, this.rebuildState(horizon));
    }
    return this.log.truncatePrefix(horizon);
  }

  /**
   * Reconstruct a live replica's full state from the remaining log:
   * latest snapshot at or before the replica's ack, then replay the
   * retained suffix up to the log tail.
   */
  recoverReplica(replicaId: string): RecoveredState<S> {
    const ack = this.registry.ackOf(replicaId);
    if (this.log.startLsn > ack + 1) {
      throw new Error(
        `invariant violated: replica "${replicaId}" ack=${ack} but log starts at ${this.log.startLsn}`,
      );
    }
    const snap = this.snapshots.latestAtOrBefore(ack);
    let state: S;
    let baseLsn: number;
    if (snap !== undefined) {
      state = this.snapshots.get(snap.lsn) as S;
      baseLsn = snap.lsn;
    } else {
      if (this.log.startLsn > 1) {
        throw new Error(`no snapshot at or before ack=${ack}; history was reclaimed`);
      }
      state = structuredClone(this.initialState);
      baseLsn = 0;
    }
    for (const entry of this.log.entriesAfter(baseLsn)) {
      state = this.reducer(state, entry.value);
    }
    return { state, baseLsn, replayedTo: this.log.lastLsn };
  }

  /** Rebuild the materialized state at `targetLsn` from snapshots + log. */
  private rebuildState(targetLsn: number): S {
    const snap = this.snapshots.latestAtOrBefore(targetLsn);
    let state: S;
    let from: number;
    if (snap !== undefined) {
      state = this.snapshots.get(snap.lsn) as S;
      from = snap.lsn;
    } else {
      if (this.log.startLsn > 1) {
        throw new Error("cannot rebuild state: history before the first snapshot was reclaimed");
      }
      state = structuredClone(this.initialState);
      from = 0;
    }
    for (const entry of this.log.entriesAfter(from)) {
      if (entry.lsn > targetLsn) break;
      state = this.reducer(state, entry.value);
    }
    return state;
  }
}
