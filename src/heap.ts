/** Binary min-heap used as the ready-candidate priority queue. */
export class MinHeap<T> {
  private items: T[] = [];

  constructor(private readonly cmp: (a: T, b: T) => number) {}

  get size(): number {
    return this.items.length;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  push(item: T): void {
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cmp(this.items[i], this.items[p]) < 0) {
        [this.items[i], this.items[p]] = [this.items[p], this.items[i]];
        i = p;
      } else {
        break;
      }
    }
  }

  pop(): T | undefined {
    const n = this.items.length;
    if (n === 0) return undefined;
    const top = this.items[0];
    const last = this.items.pop() as T;
    if (n > 1) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let m = i;
        if (l < this.items.length && this.cmp(this.items[l], this.items[m]) < 0) m = l;
        if (r < this.items.length && this.cmp(this.items[r], this.items[m]) < 0) m = r;
        if (m === i) break;
        [this.items[i], this.items[m]] = [this.items[m], this.items[i]];
        i = m;
      }
    }
    return top;
  }

  /** Sorted copy of the current contents (does not mutate the heap). */
  snapshotSorted(): T[] {
    return [...this.items].sort(this.cmp);
  }
}
