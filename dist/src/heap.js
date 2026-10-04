/** Binary min-heap ordered by a comparator. */
export class MinHeap {
    cmp;
    items = [];
    constructor(cmp) {
        this.cmp = cmp;
    }
    get size() {
        return this.items.length;
    }
    peek() {
        return this.items[0];
    }
    push(item) {
        const a = this.items;
        a.push(item);
        let i = a.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.cmp(a[i], a[p]) < 0) {
                [a[i], a[p]] = [a[p], a[i]];
                i = p;
            }
            else
                break;
        }
    }
    pop() {
        const a = this.items;
        if (a.length === 0)
            return undefined;
        const top = a[0];
        const last = a.pop();
        if (a.length > 0) {
            a[0] = last;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1;
                const r = l + 1;
                let m = i;
                if (l < a.length && this.cmp(a[l], a[m]) < 0)
                    m = l;
                if (r < a.length && this.cmp(a[r], a[m]) < 0)
                    m = r;
                if (m === i)
                    break;
                [a[i], a[m]] = [a[m], a[i]];
                i = m;
            }
        }
        return top;
    }
    toSortedArray() {
        const out = [];
        const clone = new MinHeap(this.cmp);
        clone.items = [...this.items];
        let v;
        while ((v = clone.pop()) !== undefined)
            out.push(v);
        return out;
    }
}
