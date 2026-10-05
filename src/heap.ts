/**
 * Deterministic binary min-heap ordered by (priority, seq).
 * `seq` is a monotonically increasing insertion counter, so ties are
 * broken by insertion order and the total order is unique. The internal
 * array is serializable; restoring it verbatim reproduces the exact
 * same pop sequence.
 */
export interface HeapEntry<T> {
  priority: number;
  seq: number;
  value: T;
}

function less<T>(a: HeapEntry<T>, b: HeapEntry<T>): boolean {
  if (a.priority !== b.priority) return a.priority < b.priority;
  return a.seq < b.seq;
}

export class MinHeap<T> {
  private items: Array<HeapEntry<T>>;

  private constructor(items: Array<HeapEntry<T>>) {
    this.items = items;
  }

  static empty<T>(): MinHeap<T> {
    return new MinHeap<T>([]);
  }

  /** Restore a heap from a previously serialized internal array. */
  static fromArray<T>(items: Array<HeapEntry<T>>): MinHeap<T> {
    return new MinHeap<T>(items.map((e) => ({ ...e })));
  }

  /** Copy of the internal heap-order array; suitable for JSON snapshots. */
  toArray(): Array<HeapEntry<T>> {
    return this.items.map((e) => ({ ...e }));
  }

  get size(): number {
    return this.items.length;
  }

  push(entry: HeapEntry<T>): void {
    const items = this.items;
    items.push(entry);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (less(items[i]!, items[parent]!)) {
        const tmp = items[i]!;
        items[i] = items[parent]!;
        items[parent] = tmp;
        i = parent;
      } else {
        break;
      }
    }
  }

  peek(): HeapEntry<T> | undefined {
    return this.items[0];
  }

  pop(): HeapEntry<T> | undefined {
    const items = this.items;
    const top = items[0];
    if (top === undefined) return undefined;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && less(items[left]!, items[smallest]!)) smallest = left;
        if (right < items.length && less(items[right]!, items[smallest]!)) smallest = right;
        if (smallest === i) break;
        const tmp = items[i]!;
        items[i] = items[smallest]!;
        items[smallest] = tmp;
        i = smallest;
      }
    }
    return top;
  }
}
