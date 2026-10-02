// OrderState maps event ids onto a finite ordinal domain (indices 0..n-1)
// and maintains the transitive closure of the precedence relation as an
// n x n boolean matrix. Every mutation is recorded on a trail together
// with the set of event ids it depends on, so retractions can undo exactly
// the propagations that are no longer justified and replay the rest.
export class OrderState {
  constructor() {
    this.ids = []; // index -> event id (the finite ordinal domain)
    this.index = new Map(); // event id -> index
    this.before = []; // before[i][j]: event i precedes event j
    this.deps = []; // deps[i][j]: event ids this edge is derived from
    this.reason = []; // reason[i][j]: why the edge exists (direct edges only)
    this.trail = []; // {type:'addEvent'|'edge', ..., deps:[id]}
  }

  get size() {
    return this.ids.length;
  }

  has(id) {
    return this.index.has(id);
  }

  isBefore(aId, bId) {
    const i = this.index.get(aId);
    const j = this.index.get(bId);
    return i !== undefined && j !== undefined && this.before[i][j];
  }

  addEvent(id) {
    if (this.index.has(id)) throw new Error(`event already in state: ${id}`);
    const i = this.ids.length;
    this.index.set(id, i);
    this.ids.push(id);
    for (let k = 0; k < i; k++) {
      this.before[k].push(false);
      this.deps[k].push(null);
      this.reason[k].push(null);
    }
    this.before.push(new Array(i + 1).fill(false));
    this.deps.push(new Array(i + 1).fill(null));
    this.reason.push(new Array(i + 1).fill(null));
    this.trail.push({ type: 'addEvent', id, deps: [id] });
  }

  // Adds edge from -> to with transitive closure propagation.
  // reason: {kind, deps:[id], ...}. Returns {ok:true} or {ok:false, conflict}.
  addEdge(fromId, toId, reason = { kind: 'unknown', deps: [fromId, toId] }) {
    const x = this.index.get(fromId);
    const y = this.index.get(toId);
    if (x === undefined || y === undefined) {
      throw new Error(`edge endpoint not in state: ${fromId} -> ${toId}`);
    }
    if (this.before[x][y]) return { ok: true };
    if (x === y || this.before[y][x]) {
      const path = x === y ? [fromId] : this.findPath(toId, fromId);
      const chain = [...this.pathChain(path), { from: fromId, to: toId, reason }];
      const events = [...new Set(chain.flatMap((e) => [e.from, e.to]))];
      return { ok: false, conflict: { rule: 'cycle', events, chain } };
    }
    const n = this.size;
    const preds = [];
    const succs = [];
    for (let i = 0; i < n; i++) {
      if (i === x || this.before[i][x]) preds.push(i);
      if (i === y || this.before[y][i]) succs.push(i);
    }
    const edgeDeps = reason.deps ?? [fromId, toId];
    for (const p of preds) {
      for (const s of succs) {
        if (this.before[p][s]) continue;
        this.before[p][s] = true;
        const depSet = new Set(edgeDeps);
        if (p !== x) for (const d of this.deps[p][x]) depSet.add(d);
        if (s !== y) for (const d of this.deps[y][s]) depSet.add(d);
        const direct = p === x && s === y;
        this.deps[p][s] = [...depSet];
        this.reason[p][s] = direct ? reason : { kind: 'derived' };
        this.trail.push({
          type: 'edge',
          from: this.ids[p],
          to: this.ids[s],
          direct,
          reason: this.reason[p][s],
          deps: this.deps[p][s],
        });
      }
    }
    return { ok: true };
  }

  // BFS shortest path of precedence edges from fromId to toId (id list).
  findPath(fromId, toId) {
    const s = this.index.get(fromId);
    const t = this.index.get(toId);
    const prev = new Array(this.size).fill(-1);
    prev[s] = s;
    const queue = [s];
    while (queue.length > 0) {
      const u = queue.shift();
      if (u === t) break;
      for (let v = 0; v < this.size; v++) {
        if (this.before[u][v] && prev[v] === -1) {
          prev[v] = u;
          queue.push(v);
        }
      }
    }
    const path = [];
    let cur = t;
    while (cur !== s) {
      path.push(this.ids[cur]);
      cur = prev[cur];
    }
    path.push(this.ids[s]);
    return path.reverse();
  }

  pathChain(path) {
    const chain = [];
    for (let k = 0; k + 1 < path.length; k++) {
      const i = this.index.get(path[k]);
      const j = this.index.get(path[k + 1]);
      chain.push({ from: path[k], to: path[k + 1], reason: this.reason[i][j] });
    }
    return chain;
  }

  // Undoes trail entries down to the given length (LIFO).
  undoTo(length) {
    while (this.trail.length > length) {
      const entry = this.trail.pop();
      if (entry.type === 'edge') {
        const i = this.index.get(entry.from);
        const j = this.index.get(entry.to);
        this.before[i][j] = false;
        this.deps[i][j] = null;
        this.reason[i][j] = null;
      } else if (entry.type === 'addEvent') {
        // Always the last index: later events were undone first (LIFO).
        this.index.delete(entry.id);
        this.ids.pop();
        this.before.pop();
        this.deps.pop();
        this.reason.pop();
        for (const row of this.before) row.pop();
        for (const row of this.deps) row.pop();
        for (const row of this.reason) row.pop();
      }
    }
  }
}
