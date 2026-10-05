import { compareHlc, type Hlc } from "./hlc.js";
import { covers, mergeVectorInto, type Vector } from "./vector.js";

export type Op =
  | { kind: "put"; replica: string; seq: number; hlc: Hlc; id: string; data: string }
  | { kind: "delete"; replica: string; seq: number; hlc: Hlc; id: string };

export interface Record {
  id: string;
  data: string | null;
  deleted: boolean;
  hlc: Hlc;
  origin: { replica: string; seq: number };
}

export interface BlockedReference {
  document: string;
  object: string;
  reason: "tombstone" | "missing";
}

/**
 * 单副本对象库。
 * - 删除只写墓碑（tombstone），不物理移除；
 * - 合并按 HLC 最后写入者胜出，乱序/重复投递安全；
 * - GC 仅回收“全副本确认 + 无任何活文档/历史快照根引用”的墓碑。
 */
export class Replica {
  readonly id: string;
  private clock = 0;
  private seq = 0;
  private readonly seen = new Set<string>();
  readonly log: Op[] = [];
  readonly records = new Map<string, Record>();
  readonly vector: Vector = new Map();
  readonly peerVectors = new Map<string, Vector>();
  readonly documents = new Map<string, ReadonlySet<string>>();
  readonly snapshots = new Map<string, ReadonlySet<string>>();

  constructor(id: string) {
    this.id = id;
    this.peerVectors.set(id, this.vector);
  }

  knowPeer(replicaId: string): void {
    if (!this.peerVectors.has(replicaId)) this.peerVectors.set(replicaId, new Map());
  }

  private nextHlc(): Hlc {
    this.clock += 1;
    return { time: this.clock, replica: this.id };
  }

  put(id: string, data: string): Op {
    const op: Op = { kind: "put", replica: this.id, seq: ++this.seq, hlc: this.nextHlc(), id, data };
    this.log.push(op);
    this.apply(op);
    return op;
  }

  /** 删除对象：写入墓碑。即使对象本地未知也写墓碑，防止迟到的旧 put 复活对象。 */
  remove(id: string): Op {
    const op: Op = { kind: "delete", replica: this.id, seq: ++this.seq, hlc: this.nextHlc(), id };
    this.log.push(op);
    this.apply(op);
    return op;
  }

  /** 合并操作：幂等去重 + HLC 比较，乱序到达不会回滚或复活状态。 */
  apply(op: Op): boolean {
    const key = `${op.replica}#${op.seq}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.vector.set(op.replica, Math.max(this.vector.get(op.replica) ?? 0, op.seq));
    this.clock = Math.max(this.clock, op.hlc.time);
    const existing = this.records.get(op.id);
    if (existing && compareHlc(op.hlc, existing.hlc) <= 0) return false;
    this.records.set(op.id, {
      id: op.id,
      data: op.kind === "put" ? op.data : null,
      deleted: op.kind === "delete",
      hlc: op.hlc,
      origin: { replica: op.replica, seq: op.seq },
    });
    return true;
  }

  attachDocument(docId: string, refs: Iterable<string>): void {
    this.documents.set(docId, new Set(refs));
  }

  detachDocument(docId: string): void {
    this.documents.delete(docId);
  }

  /** 历史快照：固定当前活文档可达（存在且未删除）的对象集合，作为 GC 的历史根。 */
  takeSnapshot(snapshotId: string): void {
    const reachable = new Set<string>();
    for (const refs of this.documents.values()) {
      for (const ref of refs) {
        const record = this.records.get(ref);
        if (record && !record.deleted) reachable.add(ref);
      }
    }
    this.snapshots.set(snapshotId, reachable);
  }

  releaseSnapshot(snapshotId: string): void {
    this.snapshots.delete(snapshotId);
  }

  /** 活文档引用墓碑（或缺失）对象即报阻塞。 */
  blockedReferences(): BlockedReference[] {
    const blocked: BlockedReference[] = [];
    for (const [doc, refs] of this.documents) {
      for (const ref of refs) {
        const record = this.records.get(ref);
        if (!record) blocked.push({ document: doc, object: ref, reason: "missing" });
        else if (record.deleted) blocked.push({ document: doc, object: ref, reason: "tombstone" });
      }
    }
    return blocked.sort(
      (a, b) => a.document.localeCompare(b.document) || a.object.localeCompare(b.object),
    );
  }

  private isReferenced(id: string): boolean {
    for (const refs of this.documents.values()) if (refs.has(id)) return true;
    for (const refs of this.snapshots.values()) if (refs.has(id)) return true;
    return false;
  }

  private fullyAcknowledged(origin: { replica: string; seq: number }): boolean {
    for (const vector of this.peerVectors.values()) {
      if (!covers(vector, origin.replica, origin.seq)) return false;
    }
    return true;
  }

  /** 副本确认：携带对端版本向量，表示对端已应用这些操作。 */
  acknowledge(from: string, vector: Vector): void {
    this.knowPeer(from);
    mergeVectorInto(this.peerVectors.get(from)!, vector);
  }

  /** 垃圾回收：仅回收全副本确认且无任何根（活文档/历史快照）引用的墓碑。 */
  collectGarbage(): string[] {
    const collected: string[] = [];
    for (const [id, record] of this.records) {
      if (!record.deleted) continue;
      if (!this.fullyAcknowledged(record.origin)) continue;
      if (this.isReferenced(id)) continue;
      this.records.delete(id);
      collected.push(id);
    }
    return collected.sort();
  }

  /** 导出确定性状态，用于收敛性比对。 */
  dump(): Record[] {
    return [...this.records.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}
