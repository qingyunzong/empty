// Happens-before over batches, built from:
//   - explicit deps (transitive)
//   - process order: same pid, ordered by logical clock
// Batches incomparable under this order are CONCURRENT.

export class HbGraph {
  constructor(batches) {
    this.byId = new Map(batches.map((b) => [b.id, b]));
    this.succ = new Map(batches.map((b) => [b.id, new Set()]));
    const addEdge = (from, to) => {
      if (from !== to && this.succ.has(from)) this.succ.get(from).add(to);
    };
    for (const b of batches) {
      for (const d of b.deps ?? []) addEdge(d, b.id);
    }
    const byPid = new Map();
    for (const b of batches) {
      if (!byPid.has(b.pid)) byPid.set(b.pid, []);
      byPid.get(b.pid).push(b);
    }
    for (const list of byPid.values()) {
      list.sort((x, y) => x.clock - y.clock || (x.id < y.id ? -1 : 1));
      for (let i = 1; i < list.length; i++) addEdge(list[i - 1].id, list[i].id);
    }
    this._anc = new Map();
  }

  ancestors(id) {
    if (this._anc.has(id)) return this._anc.get(id);
    const out = new Set();
    // iterative DFS over predecessors
    const pred = this._pred ??= this._buildPred();
    const stack = [...(pred.get(id) ?? [])];
    while (stack.length) {
      const x = stack.pop();
      if (out.has(x)) continue;
      out.add(x);
      for (const p of pred.get(x) ?? []) stack.push(p);
    }
    this._anc.set(id, out);
    return out;
  }

  _buildPred() {
    const pred = new Map([...this.succ.keys()].map((k) => [k, []]));
    for (const [from, tos] of this.succ) for (const t of tos) pred.get(t)?.push(from);
    return pred;
  }

  // 'before' | 'after' | 'concurrent' | 'equal'
  compare(a, b) {
    if (a === b) return 'equal';
    if (this.ancestors(b).has(a)) return 'before';
    if (this.ancestors(a).has(b)) return 'after';
    return 'concurrent';
  }

  edges() {
    const out = [];
    for (const [from, tos] of this.succ) for (const t of tos) out.push([from, t]);
    return out;
  }
}
