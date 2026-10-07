import { Heap } from "./heap.js";
import {
  deserialize,
  deserializeFromString,
  serialize,
  serializeToString,
  type SnapshotDoc,
} from "./snapshot.js";

/** 虚拟机:持有一个堆,支持快照与原子恢复。 */
export class VM {
  #heap = new Heap();

  get heap(): Heap {
    return this.#heap;
  }

  snapshot(): SnapshotDoc {
    return serialize(this.#heap);
  }

  snapshotString(): string {
    return serializeToString(this.#heap);
  }

  /**
   * 原子恢复:在独立的新堆上完成整图校验与两阶段加载,
   * 任何字段级故障都会在此之前抛出,只有整图合法时才提交,
   * 因此旧堆不会被污染。
   */
  restore(doc: unknown): void {
    const next = deserialize(doc);
    this.#heap = next;
  }

  restoreString(json: string): void {
    const next = deserializeFromString(json);
    this.#heap = next;
  }
}
