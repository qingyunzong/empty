import { Document } from "./document.js";
import type { ReplicaStore, Tombstone } from "./store.js";

export interface BlockedReference {
  readonly documentId: string;
  readonly objectId: string;
}

export interface RetainedTombstone {
  readonly replicaId: string;
  readonly objectId: string;
  readonly reasons: string[];
}

export interface GcReport {
  readonly collected: Array<{ replicaId: string; objectId: string }>;
  readonly retained: RetainedTombstone[];
}

/**
 * 集群：管理多个副本与文档，负责同步与垃圾回收。
 * GC 判定（对每个墓碑）：
 *   1. 全副本确认 —— 每个副本都已见到该墓碑版本；
 *   2. 无任何历史根（快照）引用；
 *   3. 无任何活文档引用（仍可达的墓碑不得删除）。
 */
export class Cluster {
  private readonly replicas = new Map<string, ReplicaStore>();
  private readonly documents = new Map<string, Document>();

  constructor(private readonly storeFactory: (replicaId: string) => ReplicaStore) {}

  addReplica(replicaId: string): ReplicaStore {
    const existing = this.replicas.get(replicaId);
    if (existing) return existing;
    const store = this.storeFactory(replicaId);
    this.replicas.set(replicaId, store);
    return store;
  }

  replica(replicaId: string): ReplicaStore {
    const store = this.replicas.get(replicaId);
    if (!store) throw new Error(`unknown replica "${replicaId}"`);
    return store;
  }

  createDocument(documentId: string, replicaId: string): Document {
    const doc = new Document(documentId, this.replica(replicaId));
    this.documents.set(documentId, doc);
    return doc;
  }

  sync(fromId: string, toId: string): void {
    this.replica(toId).merge(this.replica(fromId).exportOps());
  }

  syncAll(): void {
    for (const from of this.replicas.values()) {
      for (const to of this.replicas.values()) {
        if (from !== to) to.merge(from.exportOps());
      }
    }
  }

  /** 活文档对墓碑对象的引用（删除发生在引用之后的情形）。 */
  blockedReferences(): BlockedReference[] {
    const blocked: BlockedReference[] = [];
    for (const doc of this.documents.values()) {
      for (const objectId of doc.references()) {
        if (this.anyReplicaTombstones(objectId)) {
          blocked.push({ documentId: doc.id, objectId });
        }
      }
    }
    return blocked;
  }

  collectGarbage(): GcReport {
    const collected: Array<{ replicaId: string; objectId: string }> = [];
    const retained: RetainedTombstone[] = [];

    for (const store of this.replicas.values()) {
      for (const tombstone of store.listTombstones()) {
        const reasons = this.retentionReasons(tombstone);
        if (reasons.length === 0) {
          store.purgeTombstone(tombstone.id);
          collected.push({ replicaId: store.replicaId, objectId: tombstone.id });
        } else {
          retained.push({ replicaId: store.replicaId, objectId: tombstone.id, reasons });
        }
      }
    }
    return { collected, retained };
  }

  private retentionReasons(tombstone: Tombstone): string[] {
    const reasons: string[] = [];

    const unconfirmed = [...this.replicas.values()].filter(
      (replica) => !replica.hasConfirmed(tombstone),
    );
    if (unconfirmed.length > 0) {
      reasons.push(
        `unconfirmed-replicas:${unconfirmed.map((replica) => replica.replicaId).join(",")}`,
      );
    }

    for (const doc of this.documents.values()) {
      if (doc.references().has(tombstone.id)) {
        reasons.push(`live-document:${doc.id}`);
      }
      for (const [index, snapshotRefs] of [...doc.snapshotReferences()].entries()) {
        if (snapshotRefs.has(tombstone.id)) {
          reasons.push(`historical-root:${doc.id}#${doc.snapshotNames()[index]}`);
        }
      }
    }
    return reasons;
  }

  private anyReplicaTombstones(objectId: string): boolean {
    for (const store of this.replicas.values()) {
      if (store.isTombstoned(objectId)) return true;
    }
    return false;
  }
}
