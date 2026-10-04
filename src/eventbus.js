// Offline replay event bus: merges multi-source device events into a
// partial order (happens-before graph) with physical timestamps.
//
// query(a, b) verdicts:
//   REACHABLE      - a path a -> b exists in the given partial order
//   NOT_REACHABLE  - b -> a is established, or ts(a) > ts(b) rules out a -> b
//   CONCURRENT     - same physical instant, no order given (unknown order at
//                    equal timestamps is not a contradiction)
//   UNDECIDED      - ts(a) < ts(b) but no path either way; a -> b is possible
//                    through unobserved links, so it is never NOT_REACHABLE

export class InvalidInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidInputError';
    this.code = 'INVALID_INPUT';
  }
}

function requireId(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidInputError(field + ' must be a non-empty string');
  }
  return value;
}

export class EventBus {
  #events = new Map();
  #adj = new Map();
  #layers = [];

  #snapshot() {
    const adj = new Map();
    for (const [id, edges] of this.#adj) {
      const edgesCopy = new Map();
      for (const [to, kinds] of edges) edgesCopy.set(to, new Set(kinds));
      adj.set(id, edgesCopy);
    }
    return { events: new Map(this.#events), adj };
  }

  #restore(snapshot) {
    this.#events = snapshot.events;
    this.#adj = snapshot.adj;
  }

  observe(id, ts, node) {
    requireId(id, 'id');
    if (typeof ts !== 'number' || !Number.isFinite(ts)) {
      throw new InvalidInputError('ts must be a finite number');
    }
    requireId(node, 'node');
    if (this.#events.has(id)) {
      throw new InvalidInputError('duplicate id: ' + id);
    }
    this.#events.set(id, { id, ts, node });
    this.#adj.set(id, new Map());
    return 'OK';
  }

  link(a, b, kind = 'cause') {
    requireId(a, 'a');
    requireId(b, 'b');
    if (typeof kind !== 'string' || kind.length === 0) {
      throw new InvalidInputError('kind must be a non-empty string');
    }
    if (!this.#events.has(a)) throw new InvalidInputError('missing endpoint: ' + a);
    if (!this.#events.has(b)) throw new InvalidInputError('missing endpoint: ' + b);
    const edges = this.#adj.get(a);
    if (!edges.has(b)) edges.set(b, new Set());
    edges.get(b).add(kind);
    return 'OK';
  }

  checkpoint() {
    this.#layers.push(this.#snapshot());
    return 'OK';
  }

  rollback(k) {
    if (!Number.isInteger(k) || k < 0) {
      throw new InvalidInputError('k must be a non-negative integer');
    }
    if (k === 0) return 'OK';
    if (k > this.#layers.length) return 'ROLLBACK_RANGE';
    let target = null;
    for (let i = 0; i < k; i += 1) target = this.#layers.pop();
    this.#restore(target);
    return 'OK';
  }

  has(id) {
    return this.#events.has(id);
  }

  get size() {
    return this.#events.size;
  }

  get depth() {
    return this.#layers.length;
  }

  #reachable(from, to) {
    const seen = new Set([from]);
    const stack = [from];
    while (stack.length > 0) {
      const cur = stack.pop();
      const edges = this.#adj.get(cur);
      if (!edges) continue;
      for (const next of edges.keys()) {
        if (next === to) return true;
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return false;
  }

  query(a, b) {
    requireId(a, 'a');
    requireId(b, 'b');
    if (!this.#events.has(a)) throw new InvalidInputError('missing endpoint: ' + a);
    if (!this.#events.has(b)) throw new InvalidInputError('missing endpoint: ' + b);
    if (a === b) return 'REACHABLE';
    if (this.#reachable(a, b)) return 'REACHABLE';
    if (this.#reachable(b, a)) return 'NOT_REACHABLE';
    const ta = this.#events.get(a).ts;
    const tb = this.#events.get(b).ts;
    if (ta > tb) return 'NOT_REACHABLE';
    if (ta === tb) return 'CONCURRENT';
    return 'UNDECIDED';
  }

  scc() {
    const nodes = [...this.#adj.keys()];
    const rev = new Map(nodes.map((id) => [id, []]));
    for (const [from, edges] of this.#adj) {
      for (const to of edges.keys()) rev.get(to).push(from);
    }

    const visited = new Set();
    const order = [];
    for (const start of nodes) {
      if (visited.has(start)) continue;
      visited.add(start);
      const stack = [[start, false]];
      while (stack.length > 0) {
        const popped = stack.pop();
        const node = popped[0];
        const expanded = popped[1];
        if (expanded) {
          order.push(node);
          continue;
        }
        stack.push([node, true]);
        const edges = this.#adj.get(node);
        if (!edges) continue;
        for (const next of edges.keys()) {
          if (!visited.has(next)) {
            visited.add(next);
            stack.push([next, false]);
          }
        }
      }
    }

    const assigned = new Set();
    const components = [];
    for (let i = order.length - 1; i >= 0; i -= 1) {
      const start = order[i];
      if (assigned.has(start)) continue;
      const component = [];
      assigned.add(start);
      const stack = [start];
      while (stack.length > 0) {
        const node = stack.pop();
        component.push(node);
        for (const prev of rev.get(node)) {
          if (!assigned.has(prev)) {
            assigned.add(prev);
            stack.push(prev);
          }
        }
      }
      if (component.length > 1) {
        component.sort();
        components.push(component);
      }
    }
    components.sort((x, y) => {
      for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
        if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
      }
      return x.length - y.length;
    });
    return components;
  }
}
