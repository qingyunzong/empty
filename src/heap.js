// Binary min-heap used as the expiry-time heap. Ordering is fully
// deterministic: (expires, submitSeq, id).
export class MinHeap {
  constructor(compare) {
    this.items = [];
    this.compare = compare;
  }

  get size() {
    return this.items.length;
  }

  peek() {
    return this.items[0];
  }

  push(value) {
    const items = this.items;
    items.push(value);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(items[parent], value) <= 0) break;
      items[i] = items[parent];
      i = parent;
    }
    items[i] = value;
  }

  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let min = i;
        if (left < items.length && this.compare(items[left], items[min]) < 0) min = left;
        if (right < items.length && this.compare(items[right], items[min]) < 0) min = right;
        if (min === i) break;
        const tmp = items[i];
        items[i] = items[min];
        items[min] = tmp;
        i = min;
      }
    }
    return top;
  }
}
