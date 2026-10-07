import {
  itemId,
  mergeSets,
  type VersionedValue,
} from "./versionedValue";
import { increment, merge, type VersionVector } from "./versionVector";

export interface ApplyResult {
  added: VersionedValue[];
  pruned: VersionedValue[];
}

export class Replica {
  private readonly store = new Map<string, VersionedValue[]>();

  constructor(readonly id: string) {}

  getSet(key: string): VersionedValue[] {
    return [...(this.store.get(key) ?? [])];
  }

  context(key: string): VersionVector {
    let ctx: VersionVector = {};
    for (const item of this.store.get(key) ?? []) {
      ctx = merge(ctx, item.vv);
    }
    return ctx;
  }

  localWrite(key: string, value: number): VersionedValue {
    const item: VersionedValue = {
      value,
      vv: increment(this.context(key), this.id),
      tombstone: false,
    };
    this.store.set(key, [item]);
    return item;
  }

  localDelete(key: string): VersionedValue {
    const item: VersionedValue = {
      value: null,
      vv: increment(this.context(key), this.id),
      tombstone: true,
    };
    this.store.set(key, [item]);
    return item;
  }

  applyRemote(key: string, incoming: readonly VersionedValue[]): ApplyResult {
    const before = this.getSet(key);
    const after = mergeSets(before, incoming);
    this.store.set(key, after);
    const beforeIds = new Set(before.map(itemId));
    const afterIds = new Set(after.map(itemId));
    return {
      added: after.filter((item) => !beforeIds.has(itemId(item))),
      pruned: before.filter((item) => !afterIds.has(itemId(item))),
    };
  }

  keys(): string[] {
    return [...this.store.keys()];
  }
}
