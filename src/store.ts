import { LamportClock, compareVersion, type Version } from "./version.js";

export interface ObjectRecord {
  readonly id: string;
  readonly value: unknown;
  readonly version: Version;
}

export interface Tombstone {
  readonly id: string;
  readonly version: Version;
}

export type Op =
  | { readonly kind: "put"; readonly id: string; readonly value: unknown; readonly version: Version }
  | { readonly kind: "delete"; readonly id: string; readonly version: Version };

/**
 * 单副本对象库。删除只留墓碑，不物理移除；
 * 合并按 (lamport, origin) 全序做 last-writer-wins，
 * 过期的 put 无法覆盖较新的墓碑（不复活），
 * 已被 GC 清除的 id 保留高水位，迟到的旧操作同样无法复活对象。
 */
export class ReplicaStore {
  readonly clock: LamportClock;
  private readonly objects = new Map<string, ObjectRecord>();
  private readonly tombstones = new Map<string, Tombstone>();
  private readonly deleteHighWater = new Map<string, Version>();
  private readonly purgedHighWater = new Map<string, Version>();

  constructor(readonly replicaId: string) {
    this.clock = new LamportClock(replicaId);
  }

  put(id: string, value: unknown): ObjectRecord {
    const op: Op = { kind: "put", id, value, version: this.clock.tick() };
    this.apply(op);
    return this.objects.get(id)!;
  }

  delete(id: string): Tombstone {
    const op: Op = { kind: "delete", id, version: this.clock.tick() };
    this.apply(op);
    return this.tombstones.get(id)!;
  }

  get(id: string): ObjectRecord | undefined {
    return this.objects.get(id);
  }

  tombstoneOf(id: string): Tombstone | undefined {
    return this.tombstones.get(id);
  }

  isTombstoned(id: string): boolean {
    return this.tombstones.has(id);
  }

  isKnown(id: string): boolean {
    return this.objects.has(id) || this.tombstones.has(id);
  }

  listTombstones(): Tombstone[] {
    return [...this.tombstones.values()];
  }

  exportOps(): Op[] {
    const ops: Op[] = [];
    for (const record of this.objects.values()) {
      ops.push({ kind: "put", id: record.id, value: record.value, version: record.version });
    }
    for (const tombstone of this.tombstones.values()) {
      ops.push({ kind: "delete", id: tombstone.id, version: tombstone.version });
    }
    return ops;
  }

  apply(op: Op): boolean {
    this.clock.witness(op.version);
    if (op.kind === "delete") this.raiseHighWater(this.deleteHighWater, op.id, op.version);

    const purged = this.purgedHighWater.get(op.id);
    if (purged && compareVersion(op.version, purged) <= 0) return false;

    const current = this.currentVersion(op.id);
    if (current && compareVersion(op.version, current) <= 0) return false;

    if (op.kind === "put") {
      this.tombstones.delete(op.id);
      this.objects.set(op.id, { id: op.id, value: op.value, version: op.version });
    } else {
      this.objects.delete(op.id);
      this.tombstones.set(op.id, { id: op.id, version: op.version });
    }
    return true;
  }

  merge(ops: Iterable<Op>): void {
    for (const op of ops) this.apply(op);
  }

  /** 该副本是否已确认（见到）某个墓碑版本 —— 用于 GC 的全副本确认。 */
  hasConfirmed(tombstone: Tombstone): boolean {
    const seen = this.deleteHighWater.get(tombstone.id);
    return seen !== undefined && compareVersion(seen, tombstone.version) >= 0;
  }

  /** 物理移除墓碑，并记录高水位以拒绝任何迟到的旧版本操作。 */
  purgeTombstone(id: string): boolean {
    const tombstone = this.tombstones.get(id);
    if (!tombstone) return false;
    this.tombstones.delete(id);
    this.raiseHighWater(this.purgedHighWater, id, tombstone.version);
    return true;
  }

  private currentVersion(id: string): Version | undefined {
    const object = this.objects.get(id);
    const tombstone = this.tombstones.get(id);
    if (object && tombstone) {
      return compareVersion(object.version, tombstone.version) >= 0
        ? object.version
        : tombstone.version;
    }
    return object?.version ?? tombstone?.version;
  }

  private raiseHighWater(map: Map<string, Version>, id: string, version: Version): void {
    const existing = map.get(id);
    if (!existing || compareVersion(version, existing) > 0) map.set(id, version);
  }
}
