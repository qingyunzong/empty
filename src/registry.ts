import * as fs from "node:fs";
import * as path from "node:path";
import { appendJsonlSync, readJsonlSync, writeJsonAtomicSync } from "./persist.js";

/**
 * One membership change, persisted to the epoch log before it takes effect.
 * `epoch` is strictly increasing; `members` is the membership AFTER applying
 * the change, which makes the epoch log self-contained for recovery audits.
 */
export interface EpochRecord {
  epoch: number;
  kind: "register" | "deregister";
  replicaId: string;
  /** Ack vector entry carried by the event (registration ack; 0 for deregister). */
  ackLsn: number;
  members: string[];
}

interface AckFile {
  epoch: number;
  acks: Record<string, number>;
}

/**
 * Replica membership + ack vector.
 *
 * Membership changes (register/deregister) are appended to `epochs.jsonl`
 * and fsync'd BEFORE they take effect, so a deregistration is never lost
 * across a crash: on reopen the epoch log is replayed and the departed
 * replica stays gone (its stale ack cannot block compaction).
 *
 * Ack updates are volatile progress signals; they are checkpointed to
 * `acks.json` (atomic rename) and overlaid onto the membership on recovery.
 */
export class ReplicaRegistry {
  private readonly acks = new Map<string, number>();
  private epoch = 0;
  private readonly history: EpochRecord[] = [];

  private constructor(private readonly dir: string) {}

  static open(dir: string): ReplicaRegistry {
    fs.mkdirSync(dir, { recursive: true });
    const reg = new ReplicaRegistry(dir);
    for (const rec of readJsonlSync<EpochRecord>(path.join(dir, "epochs.jsonl"))) {
      reg.history.push(rec);
      reg.epoch = rec.epoch;
      if (rec.kind === "register") reg.acks.set(rec.replicaId, rec.ackLsn);
      else reg.acks.delete(rec.replicaId);
    }
    const ackPath = path.join(dir, "acks.json");
    if (fs.existsSync(ackPath)) {
      const file = JSON.parse(fs.readFileSync(ackPath, "utf8")) as AckFile;
      for (const id of [...reg.acks.keys()]) {
        const ack = file.acks[id];
        if (typeof ack === "number" && ack > (reg.acks.get(id) ?? 0)) {
          reg.acks.set(id, ack);
        }
      }
    }
    return reg;
  }

  get currentEpoch(): number {
    return this.epoch;
  }

  members(): string[] {
    return [...this.acks.keys()];
  }

  isMember(replicaId: string): boolean {
    return this.acks.has(replicaId);
  }

  ackOf(replicaId: string): number {
    const ack = this.acks.get(replicaId);
    if (ack === undefined) throw new Error(`unknown replica "${replicaId}"`);
    return ack;
  }

  /** Copy of the current ack vector (live replicas only). */
  ackVector(): Map<string, number> {
    return new Map(this.acks);
  }

  epochHistory(): readonly EpochRecord[] {
    return this.history;
  }

  register(replicaId: string, ackLsn: number): void {
    if (this.acks.has(replicaId)) {
      throw new Error(`replica "${replicaId}" is already registered`);
    }
    this.acks.set(replicaId, ackLsn);
    this.record("register", replicaId, ackLsn);
  }

  deregister(replicaId: string): void {
    if (!this.acks.has(replicaId)) {
      throw new Error(`unknown replica "${replicaId}"`);
    }
    this.acks.delete(replicaId);
    this.record("deregister", replicaId, 0);
  }

  /** Advance a replica's confirmed LSN. Monotonic; regression is rejected. */
  ack(replicaId: string, lsn: number): void {
    const current = this.ackOf(replicaId);
    if (lsn < current) {
      throw new Error(`ack regression for "${replicaId}": ${current} -> ${lsn}`);
    }
    if (lsn === current) return;
    this.acks.set(replicaId, lsn);
    this.persistAcks();
  }

  private record(kind: EpochRecord["kind"], replicaId: string, ackLsn: number): void {
    this.epoch += 1;
    const rec: EpochRecord = {
      epoch: this.epoch,
      kind,
      replicaId,
      ackLsn,
      members: this.members(),
    };
    // Persist the epoch record first; only then does the change become visible.
    appendJsonlSync(path.join(this.dir, "epochs.jsonl"), rec);
    this.history.push(rec);
    this.persistAcks();
  }

  private persistAcks(): void {
    const file: AckFile = { epoch: this.epoch, acks: Object.fromEntries(this.acks) };
    writeJsonAtomicSync(path.join(this.dir, "acks.json"), file);
  }
}
