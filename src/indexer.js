export function tokenize(text) {
  return String(text ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

export class PositionalIndex {
  constructor() {
    this.postings = new Map();
    this.docOrder = [];
    this.docs = new Set();
  }

  add(id, text) {
    if (this.docs.has(id)) return;
    this.docs.add(id);
    this.docOrder.push(id);
    tokenize(text).forEach((term, pos) => {
      let bucket = this.postings.get(term);
      if (!bucket) this.postings.set(term, (bucket = new Map()));
      let positions = bucket.get(id);
      if (!positions) bucket.set(id, (positions = []));
      positions.push(pos);
    });
  }

  remove(id) {
    if (!this.docs.delete(id)) return;
    this.docOrder = this.docOrder.filter((docId) => docId !== id);
    for (const [term, bucket] of this.postings) {
      if (bucket.delete(id) && bucket.size === 0) this.postings.delete(term);
    }
  }

  _candidateDocs(terms) {
    const uniq = [...new Set(terms)];
    if (!uniq.length) return [];
    const sets = uniq.map((term) => new Set(this.postings.get(term)?.keys() ?? []));
    const [smallest, ...rest] = sets.sort((a, b) => a.size - b.size);
    return this.docOrder.filter((id) => smallest.has(id) && rest.every((s) => s.has(id)));
  }

  phrase(terms) {
    if (!terms.length) return [];
    return this._candidateDocs(terms).filter((id) => {
      const posSets = terms.map((term) => new Set(this.postings.get(term).get(id)));
      for (const start of posSets[0]) {
        if (terms.every((_, i) => posSets[i].has(start + i))) return true;
      }
      return false;
    });
  }

  near(terms, window = 5) {
    const uniq = [...new Set(terms)];
    if (!uniq.length) return [];
    return this._candidateDocs(uniq).filter((id) => {
      const merged = [];
      uniq.forEach((term, termIndex) => {
        for (const pos of this.postings.get(term).get(id)) merged.push([pos, termIndex]);
      });
      merged.sort((a, b) => a[0] - b[0]);
      const count = new Array(uniq.length).fill(0);
      let have = 0;
      let best = Infinity;
      let left = 0;
      for (let right = 0; right < merged.length; right++) {
        if (count[merged[right][1]]++ === 0) have++;
        while (have === uniq.length) {
          best = Math.min(best, merged[right][0] - merged[left][0] + 1);
          if (--count[merged[left][1]] === 0) have--;
          left++;
        }
      }
      return best <= window;
    });
  }
}
