import { decodeCursor, encodeCursor } from './cursor.ts';
import type { Connection, Edge, VersionedNode } from './relay.ts';

export interface SyncNode<TData = unknown> extends VersionedNode {
  data: TData;
}

function upperBound(sortedKeys: Array<string>, key: string): number {
  let lo = 0;
  let hi = sortedKeys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedKeys[mid]! <= key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class SyncService<TData = unknown> {
  private readonly entries = new Map<string, SyncNode<TData>>();
  private generation = 0;

  get storeGeneration(): number {
    return this.generation;
  }

  get size(): number {
    return this.entries.size;
  }

  upsert(key: string, data: TData): SyncNode<TData> {
    this.generation += 1;
    const existing = this.entries.get(key);
    const node: SyncNode<TData> = {
      id: key,
      version: (existing?.version ?? 0) + 1,
      data,
    };
    this.entries.set(key, node);
    return node;
  }

  delete(key: string): boolean {
    if (!this.entries.delete(key)) return false;
    this.generation += 1;
    return true;
  }

  fetchConnection(after: string | null, first: number): Connection<SyncNode<TData>> {
    if (!Number.isInteger(first) || first <= 0) {
      throw new RangeError('first must be a positive integer');
    }
    const afterKey = after === null ? null : decodeCursor(after).key;
    const keys = [...this.entries.keys()].sort();
    const startIndex = afterKey === null ? 0 : upperBound(keys, afterKey);
    const pageKeys = keys.slice(startIndex, startIndex + first);
    const gen = this.generation;
    const edges: Array<Edge<SyncNode<TData>>> = pageKeys.map((key) => ({
      node: this.entries.get(key)!,
      cursor: encodeCursor(key, gen),
    }));
    return {
      edges,
      pageInfo: {
        hasNextPage: startIndex + pageKeys.length < keys.length,
        hasPreviousPage: afterKey !== null && startIndex > 0,
        startCursor: edges.length > 0 ? edges[0]!.cursor : null,
        endCursor: edges.length > 0 ? edges[edges.length - 1]!.cursor : null,
      },
    };
  }
}
