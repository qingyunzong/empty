export interface HeapEntry<T> {
  priority: number;
  seq: number;
  value: T;
}

export interface HeapSnapshot<T> {
  items: HeapEntry<T>[];
  nextSeq: number;
}

/**
 * Binary min-heap ordered by (priority, insertion sequence).
 * The sequence counter makes pop order fully deterministic even when
 * many entries share the same priority, and it survives snapshot/restore.
 */
export class MinHeap<T> {
  private items: HeapEntry<T>[];
  private nextSeq: number;

  constructor(snapshot?: HeapSnapshot<T>) {
    this.items = snapshot ? snapshot.items.map((e) => ({ ...e })) : [];
    this.nextSeq = snapshot ? snapshot.nextSeq : 0;
  }

  get size(): number {
    return this.items.length;
  }

  get sequence(): number {
    return this.nextSeq;
  }

  push(priority: number, value: T): void {
    const entry: HeapEntry<T> = { priority, seq: this.nextSeq++, value };
    this.items.push(entry);
    this.bubbleUp(this.items.length - 1);
  }

  pop(): T | undefined {
    const first = this.items[0];
    if (first === undefined) return undefined;
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      this.sinkDown(0);
    }
    return first.value;
  }

  peek(): T | undefined {
    return this.items[0]?.value;
  }

  /** Values in the order repeated pop() would yield, without mutating. */
  drainSorted(): T[] {
    const copy = new MinHeap<T>(this.snapshot());
    const out: T[] = [];
    let v: T | undefined;
    while ((v = copy.pop()) !== undefined) out.push(v);
    return out;
  }

  snapshot(): HeapSnapshot<T> {
    return {
      items: this.items.map((e) => ({ ...e })),
      nextSeq: this.nextSeq,
    };
  }

  private static less(a: HeapEntry<unknown>, b: HeapEntry<unknown>): boolean {
    return a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq);
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!MinHeap.less(this.items[index]!, this.items[parent]!)) break;
      this.swap(index, parent);
      index = parent;
    }
  }

  private sinkDown(index: number): void {
    const n = this.items.length;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < n && MinHeap.less(this.items[left]!, this.items[smallest]!)) smallest = left;
      if (right < n && MinHeap.less(this.items[right]!, this.items[smallest]!)) smallest = right;
      if (smallest === index) break;
      this.swap(index, smallest);
      index = smallest;
    }
  }

  private swap(a: number, b: number): void {
    const tmp = this.items[a]!;
    this.items[a] = this.items[b]!;
    this.items[b] = tmp;
  }
}
