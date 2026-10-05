import { BlockedReferenceError, UnknownObjectError } from "./errors.js";
import type { ReplicaStore } from "./store.js";

/**
 * 文档：活版本持有一组对象引用；快照是历史根，GC 必须尊重。
 * 活文档引用墓碑对象时立即抛 BlockedReferenceError（报阻塞）。
 */
export class Document {
  private readonly refs = new Set<string>();
  private readonly snapshots = new Map<string, ReadonlySet<string>>();

  constructor(
    readonly id: string,
    private readonly store: ReplicaStore,
  ) {}

  attach(objectId: string): void {
    if (this.store.isTombstoned(objectId)) {
      throw new BlockedReferenceError(this.id, objectId);
    }
    if (!this.store.isKnown(objectId)) {
      throw new UnknownObjectError(objectId);
    }
    this.refs.add(objectId);
  }

  detach(objectId: string): void {
    this.refs.delete(objectId);
  }

  references(): ReadonlySet<string> {
    return this.refs;
  }

  snapshot(name: string): void {
    this.snapshots.set(name, new Set(this.refs));
  }

  releaseSnapshot(name: string): boolean {
    return this.snapshots.delete(name);
  }

  snapshotNames(): string[] {
    return [...this.snapshots.keys()];
  }

  snapshotReferences(): Iterable<ReadonlySet<string>> {
    return this.snapshots.values();
  }
}
