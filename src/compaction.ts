import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface LogEntry {
  offset: number;
  key: string;
  value: string;
}

export interface Snapshot {
  /** Exclusive upper bound of offsets folded into the snapshot (== baseOffset). */
  uptoOffset: number;
  state: Record<string, string>;
}

export interface ReplicaJoin {
  /** Snapshot the new replica must load before tailing the log. */
  snapshot: Snapshot;
  /** First log offset the replica must read after applying the snapshot. */
  fromOffset: number;
}

interface EpochRecord {
  epoch: number;
  baseOffset: number;
  nextOffset: number;
  /** Live replicas: id -> highest contiguous acknowledged offset. */
  replicas: Record<string, number>;
  /** Deregistered replicas: id -> epoch in which the deregistration was persisted. */
  deregistered: Record<string, number>;
}

function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  const fd = openSync(tmp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * A key/value compacted log whose prefix is reclaimed once every live replica
 * has acknowledged it. Replica acknowledgment vectors, deregistrations and the
 * compaction frontier are persisted in an epoch record, so a crash never
 * resurrects a deregistered replica or loses the frontier.
 */
export class CompactedLog {
  private epochRecord: EpochRecord;
  private snapshotState: Record<string, string>;
  private entries: LogEntry[]; // offsets in [baseOffset, nextOffset)

  private constructor(
    private readonly dir: string,
    epochRecord: EpochRecord,
    snapshotState: Record<string, string>,
    entries: LogEntry[],
  ) {
    this.epochRecord = epochRecord;
    this.snapshotState = snapshotState;
    this.entries = entries;
  }

  static open(dir: string): CompactedLog {
    mkdirSync(dir, { recursive: true });
    const epochPath = join(dir, "epoch.json");
    if (!existsSync(epochPath)) {
      const fresh = new CompactedLog(
        dir,
        { epoch: 0, baseOffset: 0, nextOffset: 0, replicas: {}, deregistered: {} },
        {},
        [],
      );
      fresh.persist();
      return fresh;
    }
    const epochRecord = JSON.parse(readFileSync(epochPath, "utf8")) as EpochRecord;
    const snapshot = JSON.parse(readFileSync(join(dir, "snapshot.json"), "utf8")) as Snapshot;
    const entries: LogEntry[] = [];
    const logPath = join(dir, "log.jsonl");
    if (existsSync(logPath)) {
      for (const line of readFileSync(logPath, "utf8").split("\n")) {
        if (line.length > 0) entries.push(JSON.parse(line) as LogEntry);
      }
    }
    return new CompactedLog(dir, epochRecord, snapshot.state, entries);
  }

  get epoch(): number {
    return this.epochRecord.epoch;
  }

  get baseOffset(): number {
    return this.epochRecord.baseOffset;
  }

  get nextOffset(): number {
    return this.epochRecord.nextOffset;
  }

  snapshot(): Snapshot {
    return { uptoOffset: this.epochRecord.baseOffset, state: { ...this.snapshotState } };
  }

  isLive(replicaId: string): boolean {
    return replicaId in this.epochRecord.replicas;
  }

  deregisteredAtEpoch(replicaId: string): number | undefined {
    return this.epochRecord.deregistered[replicaId];
  }

  ackedOffset(replicaId: string): number {
    const acked = this.epochRecord.replicas[replicaId];
    if (acked === undefined) throw new Error(`replica ${replicaId} is not live`);
    return acked;
  }

  append(key: string, value: string): number {
    const offset = this.epochRecord.nextOffset;
    this.entries.push({ offset, key, value });
    this.epochRecord.nextOffset = offset + 1;
    this.persist();
    return offset;
  }

  /**
   * Registers a replica. The replica must load the returned snapshot before
   * tailing the log from `fromOffset`; its acknowledgment vector is
   * initialised at the compaction frontier, never at zero, so a fresh replica
   * cannot drag the frontier back into already reclaimed history.
   */
  registerReplica(replicaId: string): ReplicaJoin {
    if (this.isLive(replicaId)) throw new Error(`replica ${replicaId} is already registered`);
    const join: ReplicaJoin = { snapshot: this.snapshot(), fromOffset: this.epochRecord.baseOffset };
    this.epochRecord.replicas[replicaId] = this.epochRecord.baseOffset;
    this.bumpEpoch();
    this.persist();
    return join;
  }

  ack(replicaId: string, offset: number): void {
    const current = this.epochRecord.replicas[replicaId];
    if (current === undefined) throw new Error(`replica ${replicaId} is not live`);
    if (offset < this.epochRecord.baseOffset) {
      throw new Error(
        `ack offset ${offset} is below the compaction frontier ${this.epochRecord.baseOffset}`,
      );
    }
    if (offset > this.epochRecord.nextOffset) {
      throw new Error(`ack offset ${offset} is beyond the log end ${this.epochRecord.nextOffset}`);
    }
    if (offset <= current) return; // stale acknowledgment
    this.epochRecord.replicas[replicaId] = offset;
    this.persist();
  }

  /**
   * Deregisters a replica and persists the fact in the epoch record before
   * returning, so a crash cannot resurrect it.
   */
  deregister(replicaId: string): void {
    if (!this.isLive(replicaId)) throw new Error(`replica ${replicaId} is not live`);
    delete this.epochRecord.replicas[replicaId];
    this.epochRecord.deregistered[replicaId] = this.bumpEpoch();
    this.persist();
  }

  /**
   * Reclaims the log prefix acknowledged by every live replica. With no live
   * replicas the whole log is reclaimable: any future replica must join via
   * the snapshot anyway.
   */
  compact(): number {
    const acks = Object.values(this.epochRecord.replicas);
    let frontier = acks.length === 0 ? this.epochRecord.nextOffset : Math.min(...acks);
    frontier = Math.min(frontier, this.epochRecord.nextOffset);
    if (frontier <= this.epochRecord.baseOffset) return this.epochRecord.baseOffset;
    const kept: LogEntry[] = [];
    for (const entry of this.entries) {
      if (entry.offset < frontier) this.snapshotState[entry.key] = entry.value;
      else kept.push(entry);
    }
    this.entries = kept;
    this.epochRecord.baseOffset = frontier;
    this.persist();
    return frontier;
  }

  /**
   * Reconstructs the full key/value state a live replica must hold: snapshot
   * plus every remaining log entry. Used to verify that the remaining log
   * suffices to recover all live replicas.
   */
  recoverReplica(replicaId: string): Record<string, string> {
    if (!this.isLive(replicaId)) throw new Error(`replica ${replicaId} is not live`);
    const state: Record<string, string> = { ...this.snapshotState };
    for (const entry of this.entries) state[entry.key] = entry.value;
    return state;
  }

  private bumpEpoch(): number {
    this.epochRecord.epoch += 1;
    return this.epochRecord.epoch;
  }

  private persist(): void {
    writeAtomic(join(this.dir, "epoch.json"), JSON.stringify(this.epochRecord, null, 2));
    const snapshot: Snapshot = {
      uptoOffset: this.epochRecord.baseOffset,
      state: this.snapshotState,
    };
    writeAtomic(join(this.dir, "snapshot.json"), JSON.stringify(snapshot, null, 2));
    writeAtomic(
      join(this.dir, "log.jsonl"),
      this.entries.map((entry) => JSON.stringify(entry)).join("\n") +
        (this.entries.length > 0 ? "\n" : ""),
    );
  }
}
