/**
 * CreditNetwork: nodes are accounts, directed edges are credit commitments
 * with integer capacities. Freezing moves "credit flow" from a funding
 * source to a customer account; frozen amounts occupy edge capacity until
 * released. Max-flow (Edmonds-Karp) decides feasibility; on rejection a
 * min-cut certificate (customer-side nodes + crossing edges) is returned.
 */

export class CreditError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CreditError';
    this.code = code;
  }
}

const SEP = '';
const keyOf = (from, to) => `${from}${SEP}${to}`;

function assertName(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.includes(SEP)) {
    throw new CreditError('INVALID_COMMAND', `${field} must be a non-empty string`);
  }
}

function assertCapacity(value, field = 'capacity') {
  if (!Number.isInteger(value) || value < 0) {
    throw new CreditError('INVALID_COMMAND', `${field} must be a non-negative integer`);
  }
}

function assertAmount(value, field = 'amount') {
  if (!Number.isInteger(value) || value <= 0) {
    throw new CreditError('INVALID_COMMAND', `${field} must be a positive integer`);
  }
}

/**
 * Edmonds-Karp max-flow on a residual capacity matrix, stopping early once
 * `limit` units have been sent. Returns { value, flow } where flow is a
 * signed net-flow matrix (flow[u][v] === -flow[v][u]).
 */
function computeFlow(size, cap, s, t, limit) {
  const flow = Array.from({ length: size }, () => new Array(size).fill(0));
  let total = 0;
  while (total < limit) {
    const prev = new Array(size).fill(-1);
    prev[s] = s;
    const queue = [s];
    let head = 0;
    while (head < queue.length && prev[t] === -1) {
      const u = queue[head++];
      for (let v = 0; v < size; v++) {
        if (prev[v] === -1 && cap[u][v] - flow[u][v] > 0) {
          prev[v] = u;
          queue.push(v);
        }
      }
    }
    if (prev[t] === -1) break;
    let bottleneck = limit - total;
    for (let v = t; v !== s; v = prev[v]) {
      bottleneck = Math.min(bottleneck, cap[prev[v]][v] - flow[prev[v]][v]);
    }
    for (let v = t; v !== s; v = prev[v]) {
      flow[prev[v]][v] += bottleneck;
      flow[v][prev[v]] -= bottleneck;
    }
    total += bottleneck;
  }
  return { value: total, flow };
}

/** Nodes reachable from `s` in the residual graph of (cap - flow). */
function reachableFrom(size, cap, flow, s) {
  const seen = new Array(size).fill(false);
  seen[s] = true;
  const stack = [s];
  while (stack.length) {
    const u = stack.pop();
    for (let v = 0; v < size; v++) {
      if (!seen[v] && cap[u][v] - flow[u][v] > 0) {
        seen[v] = true;
        stack.push(v);
      }
    }
  }
  return seen;
}

/**
 * Decompose an s-t flow (given as positive per-edge amounts) into s-t paths.
 * Any residual cyclic flow is discarded; path values always sum to the flow
 * value, so the returned paths carry exactly the requested amount.
 */
function decomposePaths(source, target, edgeFlows) {
  const remaining = new Map(edgeFlows);
  const adjacency = new Map();
  for (const [key, amount] of remaining) {
    if (amount <= 0) continue;
    const [from, to] = key.split(SEP);
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from).push({ to, key });
  }
  const paths = [];
  for (;;) {
    const prev = new Map();
    const seen = new Set([source]);
    const stack = [source];
    while (stack.length && !prev.has(target)) {
      const u = stack.pop();
      for (const arc of adjacency.get(u) ?? []) {
        if ((remaining.get(arc.key) ?? 0) > 0 && !seen.has(arc.to)) {
          seen.add(arc.to);
          prev.set(arc.to, { from: u, key: arc.key });
          stack.push(arc.to);
        }
      }
    }
    if (!prev.has(target)) break;
    const keys = [];
    for (let node = target; node !== source; node = prev.get(node).from) {
      keys.push(prev.get(node).key);
    }
    keys.reverse();
    let bottleneck = Infinity;
    for (const key of keys) bottleneck = Math.min(bottleneck, remaining.get(key));
    for (const key of keys) remaining.set(key, remaining.get(key) - bottleneck);
    paths.push({ keys, amount: bottleneck });
  }
  return paths;
}

export class CreditNetwork {
  constructor() {
    this.nodes = new Set();
    this.edges = new Map(); // key -> { from, to, capacity, frozen }
    this.freezes = new Map(); // id -> { id, source, target, remaining, paths }
    this._nextFreezeId = 1;
  }

  hasNode(name) {
    return this.nodes.has(name);
  }

  getEdge(from, to) {
    return this.edges.get(keyOf(from, to));
  }

  frozenOn(from, to) {
    return this.getEdge(from, to)?.frozen ?? 0;
  }

  addEdge(from, to, capacity) {
    assertName(from, 'from');
    assertName(to, 'to');
    assertCapacity(capacity);
    if (from === to) {
      throw new CreditError('INVALID_COMMAND', 'self-loop edges are not allowed');
    }
    const key = keyOf(from, to);
    if (this.edges.has(key)) {
      throw new CreditError('DUPLICATE_EDGE', `edge ${from} -> ${to} already exists; use set-capacity`);
    }
    this.nodes.add(from);
    this.nodes.add(to);
    this.edges.set(key, { from, to, capacity, frozen: 0 });
    return { ok: true, from, to, capacity };
  }

  setCapacity(from, to, capacity) {
    assertName(from, 'from');
    assertName(to, 'to');
    assertCapacity(capacity);
    const edge = this.getEdge(from, to);
    if (!edge) {
      throw new CreditError('UNKNOWN_EDGE', `no edge ${from} -> ${to}`);
    }
    if (capacity < edge.frozen) {
      throw new CreditError(
        'CAPACITY_BELOW_FROZEN',
        `cannot set capacity ${capacity} below frozen amount ${edge.frozen} on ${from} -> ${to}`
      );
    }
    edge.capacity = capacity;
    return { ok: true, from, to, capacity };
  }

  _residualMatrix() {
    const nodes = [...this.nodes].sort();
    const index = new Map(nodes.map((name, i) => [name, i]));
    const cap = Array.from({ length: nodes.length }, () => new Array(nodes.length).fill(0));
    for (const edge of this.edges.values()) {
      cap[index.get(edge.from)][index.get(edge.to)] += edge.capacity - edge.frozen;
    }
    return { nodes, index, cap };
  }

  _requireNode(name, code, role) {
    if (!this.nodes.has(name)) {
      throw new CreditError(code, `unknown ${role}: ${name}`);
    }
  }

  /** Max freezable amount from source to target given current frozen state. */
  maxFlowValue(source, target) {
    this._requireNode(source, 'UNKNOWN_SOURCE', 'source');
    this._requireNode(target, 'UNKNOWN_TARGET', 'target');
    const { nodes, index, cap } = this._residualMatrix();
    return computeFlow(nodes.length, cap, index.get(source), index.get(target), Number.MAX_SAFE_INTEGER).value;
  }

  freeze(source, target, amount) {
    assertName(source, 'source');
    assertName(target, 'target');
    assertAmount(amount);
    if (source === target) {
      throw new CreditError('INVALID_COMMAND', 'source and target must differ');
    }
    this._requireNode(source, 'UNKNOWN_SOURCE', 'source');
    this._requireNode(target, 'UNKNOWN_TARGET', 'target');

    const { nodes, index, cap } = this._residualMatrix();
    const s = index.get(source);
    const t = index.get(target);
    const { value, flow } = computeFlow(nodes.length, cap, s, t, amount);

    if (value < amount) {
      // Rejected: build the min-cut certificate. Nodes unreachable from the
      // source in the residual graph form the customer side of the cut.
      const reachable = reachableFrom(nodes.length, cap, flow, s);
      const cutNodes = nodes.filter((_, i) => !reachable[i]);
      const cutEdges = [];
      let cutCapacity = 0;
      for (const edge of this.edges.values()) {
        const u = index.get(edge.from);
        const v = index.get(edge.to);
        if (reachable[u] && !reachable[v]) {
          const residual = edge.capacity - edge.frozen;
          cutEdges.push({ from: edge.from, to: edge.to, capacity: residual });
          cutCapacity += residual;
        }
      }
      return {
        ok: false,
        reason: 'insufficient-capacity',
        source,
        target,
        requested: amount,
        maxFreezable: value,
        cut: { nodes: cutNodes, edges: cutEdges, capacity: cutCapacity },
      };
    }

    // Success: extract per-edge flows, decompose into s-t paths, occupy capacity.
    const rawFlows = new Map();
    for (const edge of this.edges.values()) {
      const x = flow[index.get(edge.from)][index.get(edge.to)];
      if (x > 0) rawFlows.set(keyOf(edge.from, edge.to), x);
    }
    const paths = decomposePaths(source, target, rawFlows).map((p) => ({
      edges: p.keys.map((key) => key.split(SEP)),
      amount: p.amount,
    }));

    const perEdge = new Map();
    for (const path of paths) {
      for (const [from, to] of path.edges) {
        const key = keyOf(from, to);
        perEdge.set(key, (perEdge.get(key) ?? 0) + path.amount);
        this.edges.get(key).frozen += path.amount;
      }
    }

    const freezeId = `f${this._nextFreezeId++}`;
    this.freezes.set(freezeId, {
      id: freezeId,
      source,
      target,
      remaining: amount,
      paths: paths.map((p) => ({ edges: p.edges, amount: p.amount })),
    });

    return {
      ok: true,
      freezeId,
      source,
      target,
      amount,
      flows: [...perEdge.entries()].map(([key, edgeAmount]) => {
        const [from, to] = key.split(SEP);
        return { from, to, amount: edgeAmount };
      }),
      paths: paths.map((p) => ({
        edges: p.edges.map(([from, to]) => ({ from, to })),
        amount: p.amount,
      })),
    };
  }

  release(freezeId, amount = undefined) {
    if (typeof freezeId !== 'string' || !this.freezes.has(freezeId)) {
      throw new CreditError('UNKNOWN_FREEZE', `unknown freeze id: ${String(freezeId)}`);
    }
    const record = this.freezes.get(freezeId);
    if (record.remaining === 0) {
      throw new CreditError('DUPLICATE_RELEASE', `freeze ${freezeId} is already fully released`);
    }
    const releaseAmount = amount === undefined || amount === null ? record.remaining : amount;
    assertAmount(releaseAmount);
    if (releaseAmount > record.remaining) {
      throw new CreditError(
        'OVER_RELEASE',
        `cannot release ${releaseAmount}; only ${record.remaining} remains on freeze ${freezeId}`
      );
    }
    let need = releaseAmount;
    for (const path of record.paths) {
      if (need === 0) break;
      const take = Math.min(path.amount, need);
      if (take === 0) continue;
      path.amount -= take;
      for (const [from, to] of path.edges) {
        this.edges.get(keyOf(from, to)).frozen -= take;
      }
      need -= take;
    }
    record.remaining -= releaseAmount;
    return { ok: true, freezeId, released: releaseAmount, remaining: record.remaining };
  }

  /** Serializable snapshot of the current state (useful for tests/debugging). */
  getState() {
    return {
      edges: [...this.edges.values()].map((e) => ({ ...e })),
      freezes: [...this.freezes.values()].map((f) => ({
        id: f.id,
        source: f.source,
        target: f.target,
        remaining: f.remaining,
      })),
    };
  }
}
