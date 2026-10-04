const SEP = '';

export class NetworkError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'NetworkError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const edgeKey = (a, b) => (a < b ? a + SEP + b : b + SEP + a);
const sortedPair = (a, b) => (a < b ? [a, b] : [b, a]);

const sortPairs = (pairs) =>
  pairs.sort((p, q) => (p[0] === q[0] ? (p[1] < q[1] ? -1 : 1) : p[0] < q[0] ? -1 : 1));

const sortComponents = (components) => {
  for (const component of components) component.sort();
  return components.sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0));
};

/**
 * Connected components of the graph induced by `nodes` and the given
 * adjacency (Map node -> iterable of neighbor nodes).
 */
export function connectedComponents(nodes, adjacency) {
  const seen = new Set();
  const components = [];
  for (const start of nodes) {
    if (seen.has(start)) continue;
    const component = [];
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const node = stack.pop();
      component.push(node);
      for (const next of adjacency.get(node) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    components.push(component);
  }
  return sortComponents(components);
}

/**
 * Tarjan's bridge-finding algorithm for an undirected simple graph.
 * Returns sorted list of [a, b] pairs (a < b) that are bridges.
 */
export function tarjanBridges(nodes, adjacency) {
  const discovered = new Map();
  const low = new Map();
  const bridges = [];
  let time = 0;

  const visit = (node, parent) => {
    discovered.set(node, time);
    low.set(node, time);
    time += 1;
    for (const neighbor of adjacency.get(node) ?? []) {
      if (neighbor === parent) continue;
      if (!discovered.has(neighbor)) {
        visit(neighbor, node);
        low.set(node, Math.min(low.get(node), low.get(neighbor)));
        if (low.get(neighbor) > discovered.get(node)) {
          bridges.push(sortedPair(node, neighbor));
        }
      } else {
        low.set(node, Math.min(low.get(node), discovered.get(neighbor)));
      }
    }
  };

  for (const node of nodes) {
    if (!discovered.has(node)) visit(node, null);
  }
  return sortPairs(bridges);
}

/**
 * Lexicographically smallest shortest path between `from` and `to`.
 * Returns null when the nodes are not connected.
 */
export function lexSmallestShortestPath(from, to, adjacency) {
  if (from === to) return [from];
  const distToTarget = new Map([[to, 0]]);
  let frontier = [to];
  while (frontier.length > 0) {
    const next = [];
    for (const node of frontier) {
      for (const neighbor of adjacency.get(node) ?? []) {
        if (!distToTarget.has(neighbor)) {
          distToTarget.set(neighbor, distToTarget.get(node) + 1);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }
  if (!distToTarget.has(from)) return null;

  const path = [from];
  let current = from;
  while (current !== to) {
    let best = null;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (distToTarget.get(neighbor) === distToTarget.get(current) - 1) {
        if (best === null || neighbor < best) best = neighbor;
      }
    }
    if (best === null) return null;
    path.push(best);
    current = best;
  }
  return path;
}

export class PaymentNetwork {
  #nodes = new Set();
  #edges = new Map();

  #requireNode(node) {
    if (typeof node !== 'string' || node.length === 0) {
      throw new NetworkError('INVALID_NODE', `node must be a non-empty string, got: ${JSON.stringify(node)}`);
    }
    if (!this.#nodes.has(node)) {
      throw new NetworkError('UNKNOWN_NODE', `unknown node: ${node}`);
    }
  }

  #requireEdge(a, b) {
    this.#requireNode(a);
    this.#requireNode(b);
    const edge = this.#edges.get(edgeKey(a, b));
    if (!edge) {
      throw new NetworkError('UNKNOWN_EDGE', `no edge between ${a} and ${b}`);
    }
    return edge;
  }

  /** Adjacency of currently open edges: Map node -> sorted neighbor array. */
  #openAdjacency(excludeKey = null) {
    const adjacency = new Map([...this.#nodes].map((node) => [node, []]));
    for (const [key, edge] of this.#edges) {
      if (!edge.open || key === excludeKey) continue;
      adjacency.get(edge.a).push(edge.b);
      adjacency.get(edge.b).push(edge.a);
    }
    for (const neighbors of adjacency.values()) neighbors.sort();
    return adjacency;
  }

  addEdge(a, b, bandwidth = 1) {
    if (typeof a !== 'string' || a.length === 0 || typeof b !== 'string' || b.length === 0) {
      throw new NetworkError('INVALID_NODE', `nodes must be non-empty strings, got: ${JSON.stringify(a)}, ${JSON.stringify(b)}`);
    }
    if (a === b) {
      throw new NetworkError('SELF_LOOP', `self-loop not allowed: ${a}`);
    }
    if (typeof bandwidth !== 'number' || !Number.isFinite(bandwidth) || bandwidth <= 0) {
      throw new NetworkError('INVALID_BANDWIDTH', `bandwidth must be a positive number, got: ${JSON.stringify(bandwidth)}`);
    }
    const key = edgeKey(a, b);
    if (this.#edges.has(key)) {
      throw new NetworkError('DUPLICATE_EDGE', `edge already exists between ${a} and ${b}`);
    }
    this.#nodes.add(a);
    this.#nodes.add(b);
    const edge = { a, b, bandwidth, open: true };
    this.#edges.set(key, edge);
    return { a, b, bandwidth, open: true };
  }

  closeEdge(a, b) {
    const edge = this.#requireEdge(a, b);
    if (!edge.open) {
      throw new NetworkError('EDGE_ALREADY_CLOSED', `edge already closed between ${edge.a} and ${edge.b}`);
    }
    const adjacency = this.#openAdjacency();
    const isBridge = tarjanBridges(this.#nodes, adjacency).some(
      ([x, y]) => (x === edge.a && y === edge.b) || (x === edge.b && y === edge.a),
    );
    let bridgeCertificate = null;
    if (isBridge) {
      const splitComponents = connectedComponents(this.#nodes, this.#openAdjacency(edgeKey(a, b)));
      bridgeCertificate = {
        edge: sortedPair(edge.a, edge.b),
        splitsInto: splitComponents,
        proof: `removing ${edge.a}-${edge.b} raises component count to ${splitComponents.length}`,
      };
    }
    edge.open = false;
    return { a: edge.a, b: edge.b, open: false, bridgeCertificate };
  }

  openEdge(a, b) {
    const edge = this.#requireEdge(a, b);
    if (edge.open) {
      throw new NetworkError('EDGE_NOT_CLOSED', `edge is not closed between ${edge.a} and ${edge.b}`);
    }
    edge.open = true;
    return { a: edge.a, b: edge.b, open: true };
  }

  bridges() {
    return tarjanBridges(this.#nodes, this.#openAdjacency());
  }

  components() {
    return connectedComponents(this.#nodes, this.#openAdjacency());
  }

  /**
   * Atomically cancel a batch of payments. Every payment's endpoints must
   * stay connected through open edges; if any payment cannot be routed the
   * whole batch fails and no state changes.
   */
  cancelBatch(payments) {
    if (!Array.isArray(payments) || payments.length === 0) {
      throw new NetworkError('EMPTY_BATCH', 'batch must contain at least one payment');
    }
    const adjacency = this.#openAdjacency();
    const routed = [];
    const failures = [];
    payments.forEach((payment, index) => {
      const { id = `payment-${index}`, from, to } = payment ?? {};
      try {
        this.#requireNode(from);
        this.#requireNode(to);
      } catch (error) {
        failures.push({ id, from, to, code: error.code, message: error.message });
        return;
      }
      const path = lexSmallestShortestPath(from, to, adjacency);
      if (path === null) {
        failures.push({ id, from, to, code: 'NOT_CONNECTED', message: `no open route from ${from} to ${to}` });
        return;
      }
      routed.push({ id, from, to, path });
    });
    if (failures.length > 0) {
      throw new NetworkError('BATCH_NOT_ROUTABLE', `batch rejected: ${failures.length} payment(s) not routable; nothing cancelled`, failures);
    }

    const affectedNodes = new Set();
    for (const { from, to } of routed) {
      affectedNodes.add(from);
      affectedNodes.add(to);
    }
    const affectedComponents = connectedComponents(this.#nodes, adjacency).filter((component) =>
      component.some((node) => affectedNodes.has(node)),
    );

    return {
      cancelled: routed,
      bridges: this.bridges(),
      affectedComponents,
    };
  }

  snapshot() {
    return {
      nodes: [...this.#nodes].sort(),
      edges: [...this.#edges.values()]
        .map(({ a, b, bandwidth, open }) => ({ a, b, bandwidth, open }))
        .sort((p, q) => (p.a === q.a ? (p.b < q.b ? -1 : 1) : p.a < q.a ? -1 : 1)),
    };
  }
}
