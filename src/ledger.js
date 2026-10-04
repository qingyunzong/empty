// Payment reversal ledger: dependency graph + reversal propagation.
//
// Edge u -> v means "the settlement of u depends on v".
// Cancelling a transaction t reverses t and every transaction reachable
// from t by following dependency edges (its dependency chain). Because an
// SCC is mutually reachable, cancelling any member reverses the whole SCC.

export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

const byLex = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (iterable) => [...iterable].sort(byLex);

// Set of nodes reachable from `start` (inclusive) following edge direction.
export function reachable(adj, start) {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length > 0) {
    const u = stack.pop();
    for (const v of adj.get(u) ?? []) {
      if (!seen.has(v)) {
        seen.add(v);
        stack.push(v);
      }
    }
  }
  return seen;
}

// Tarjan's SCC algorithm. Returns components as sorted arrays of nodes.
export function tarjanSCC(nodes, adj) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let counter = 0;

  function strongconnect(v) {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of sorted(adj.get(v) ?? [])) {
      if (!index.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      components.push(comp.sort(byLex));
    }
  }

  for (const v of sorted(nodes)) {
    if (!index.has(v)) strongconnect(v);
  }
  return components;
}

export class Ledger {
  #nodes = new Set();
  #adj = new Map();
  #reversed = new Set();
  #events = new Set();

  #addNode(x) {
    if (!this.#nodes.has(x)) {
      this.#nodes.add(x);
      this.#adj.set(x, new Set());
    }
  }

  #requireNode(x) {
    if (!this.#nodes.has(x)) {
      throw new LedgerError('UNKNOWN_NODE', `unknown transaction: ${x}`);
    }
  }

  #requireFreshEvent(id) {
    if (this.#events.has(id)) {
      throw new LedgerError('DUPLICATE_EVENT', `event id already used: ${id}`);
    }
  }

  addDep(u, v) {
    this.#addNode(u);
    this.#addNode(v);
    if (this.#adj.get(u).has(v)) {
      throw new LedgerError('DUPLICATE_DEP', `dependency already exists: ${u} -> ${v}`);
    }
    this.#adj.get(u).add(v);
    return { u, v };
  }

  removeDep(u, v) {
    this.#requireNode(u);
    this.#requireNode(v);
    if (!this.#adj.get(u).has(v)) {
      throw new LedgerError('UNKNOWN_DEP', `no such dependency: ${u} -> ${v}`);
    }
    this.#adj.get(u).delete(v);
    return { u, v };
  }

  cancel(eventId, tx) {
    this.#requireFreshEvent(eventId);
    this.#requireNode(tx);
    if (this.#reversed.has(tx)) {
      throw new LedgerError('DUPLICATE_CANCEL', `transaction already REVERSED: ${tx}`);
    }
    const affected = sorted(reachable(this.#adj, tx)).filter((n) => !this.#reversed.has(n));
    for (const n of affected) this.#reversed.add(n);
    this.#events.add(eventId);
    return { event: eventId, tx, affected };
  }

  restore(eventId, tx) {
    this.#requireFreshEvent(eventId);
    this.#requireNode(tx);
    if (!this.#reversed.has(tx)) {
      throw new LedgerError('NOT_REVERSED', `transaction is not REVERSED: ${tx}`);
    }
    const affected = sorted(reachable(this.#adj, tx)).filter((n) => this.#reversed.has(n));
    for (const n of affected) this.#reversed.delete(n);
    this.#events.add(eventId);
    return { event: eventId, tx, affected };
  }

  query() {
    const nodes = sorted(this.#nodes);
    const comps = tarjanSCC(nodes, this.#adj);
    comps.sort((a, b) => byLex(a[0], b[0]));
    const components = comps.map((members, i) => ({ id: `C${i}`, members }));
    const compOf = new Map();
    components.forEach((c, i) => c.members.forEach((m) => compOf.set(m, i)));

    // Condensation DAG edges + cross-component edge list for the certificate.
    const cadj = components.map(() => new Set());
    const crossComponentEdges = [];
    for (const u of nodes) {
      for (const v of sorted(this.#adj.get(u))) {
        const cu = compOf.get(u);
        const cv = compOf.get(v);
        if (cu !== cv) {
          cadj[cu].add(cv);
          crossComponentEdges.push({
            from: u,
            to: v,
            fromComponent: `C${cu}`,
            toComponent: `C${cv}`,
          });
        }
      }
    }

    // Deterministic Kahn topological order of the condensation DAG
    // (dependents before the components they depend on).
    const indeg = components.map(() => 0);
    for (const outs of cadj) for (const v of outs) indeg[v] += 1;
    const ready = [];
    components.forEach((_, i) => {
      if (indeg[i] === 0) ready.push(i);
    });
    const topoOrder = [];
    while (ready.length > 0) {
      ready.sort((a, b) => a - b);
      const c = ready.shift();
      topoOrder.push(`C${c}`);
      for (const d of sorted(cadj[c])) {
        indeg[d] -= 1;
        if (indeg[d] === 0) ready.push(d);
      }
    }

    // Propagation certificate: DFS forest edges over the whole graph
    // (deterministic order) plus every edge crossing component boundaries.
    const dfsEdges = [];
    const visited = new Set();
    const dfs = (u) => {
      visited.add(u);
      for (const v of sorted(this.#adj.get(u))) {
        if (!visited.has(v)) {
          dfsEdges.push([u, v]);
          dfs(v);
        }
      }
    };
    for (const u of nodes) {
      if (!visited.has(u)) dfs(u);
    }

    return {
      affected: sorted(this.#reversed),
      components,
      topoOrder,
      certificate: { dfsEdges, crossComponentEdges },
    };
  }
}
