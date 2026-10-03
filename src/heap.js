// Binary min-heap with a deterministic total-order comparator.
// Used as the expiry-time heap; stale entries (auths no longer active)
// are discarded lazily at the top via discardWhile().
export class MinHeap {
  #items = [];
  #compare;

  constructor(compare) {
    this.#compare = compare;
  }

  get size() {
    return this.#items.length;
  }

  peek() {
    return this.#items[0];
  }

  push(item) {
    const items = this.#items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.#compare(items[i], items[parent]) < 0) {
        [items[i], items[parent]] = [items[parent], items[i]];
        i = parent;
      } else {
        break;
      }
    }
  }

  pop() {
    const items = this.#items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = 2 * i + 2;
        let smallest = i;
        if (left < items.length && this.#compare(items[left], items[smallest]) < 0) smallest = left;
        if (right < items.length && this.#compare(items[right], items[smallest]) < 0) smallest = right;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest], items[i]];
        i = smallest;
      }
    }
    return top;
  }

  // Pop and drop every top element matching `stale`; stops at the first
  // non-stale top. Used to lazily evict auths removed out of band.
  discardWhile(stale) {
    while (this.#items.length > 0 && stale(this.#items[0])) this.pop();
  }
}
