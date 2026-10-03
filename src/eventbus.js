/**
 * eventbus.js — offline replay of a production-line event bus.
 *
 * Merges multi-source device events into a causal partial order (links),
 * answers reachability queries, and detects cyclic sensor dependencies (SCCs).
 *
 * Query semantics (query(a, b)):
 *   REACHABLE      — a reaches b via one or more causal links (a causally precedes b)
 *   NOT_REACHABLE  — the reverse order is proven: b reaches a, so a cannot reach b
 *   CONCURRENT     — no causal path either way AND both events share the same
 *                    physical timestamp (same moment, only the given partial
 *                    order may order them; unknown order is not a contradiction)
 *   UNDECIDED      — no causal path either way and timestamps differ; the true
 *                    order is unknown. UNDECIDED is never reported as NOT_REACHABLE.
 */

export const INVALID_INPUT = 'INVALID_INPUT';
export const ROLLBACK_RANGE = 'ROLLBACK_RANGE';

export const REACHABLE = 'REACHABLE';
export const NOT_REACHABLE = 'NOT_REACHABLE';
export const CONCURRENT = 'CONCURRENT';
export const UNDECIDED = 'UNDECIDED';

export class BusError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BusError';
    this.code = code;
  }
}

function isId(value) {
  return typeof value === 'string' && value.length > 0;
}

export class EventBus {
  #events = new Map(); // id -> { id, ts, node }
  #adj = new Map();    // id -> Set<id> (causal edges a -> b)
  #log = [];           // applied mutating ops, for exact checkpoint rebuild
  #layers = [];        // log length recorded at each checkpoint

  get size() {
    return this.#events.size;
  }

  get layers() {
    return this.#layers.length;
  }

  observe({ id, ts, node } = {}) {
    if (!isId(id) || !isId(node) || typeof ts !== 'number' || !Number.isFinite(ts)) {
      throw new BusError(INVALID_INPUT, 'observe requires non-empty string id/node and finite numeric ts');
    }
    if (this.#events.has(id)) {
      throw new BusError(INVALID_INPUT, `duplicate event id: ${id}`);
    }
    const entry = { op: 'observe', id, ts, node };
    this.#applyObserve(entry);
    this.#log.push(entry);
    return id;
  }

  link({ a, b, kind = 'causes' } = {}) {
    if (!isId(a) || !isId(b) || typeof kind !== 'string' || kind.length === 0) {
      throw new BusError(INVALID_INPUT, 'link requires non-empty string a/b/kind');
    }
    if (!this.#events.has(a)) {
      throw new BusError(INVALID_INPUT, `link endpoint not observed: ${a}`);
    }
    if (!this.#events.has(b)) {
      throw new BusError(INVALID_INPUT, `link endpoint not observed: ${b}`);
    }
    const entry = { op: 'link', a, b, kind };
    this.#applyLink(entry);
    this.#log.push(entry);
    return true;
  }

  checkpoint() {
    this.#layers.push(this.#log.length);
    return this.#layers.length;
  }

  /**
   * Undo exactly the most recent k checkpoint layers.
   * On failure the state is left untouched.
   *   k < 0 or non-integer -> INVALID_INPUT
   *   k > current layers   -> ROLLBACK_RANGE
   */
  rollback(k) {
    if (!Number.isInteger(k) || k < 0) {
      throw new BusError(INVALID_INPUT, 'rollback k must be a non-negative integer');
    }
    if (k > this.#layers.length) {
      throw new BusError(ROLLBACK_RANGE, `cannot rollback ${k} layer(s): only ${this.#layers.length} checkpoint layer(s) exist`);
    }
    if (k === 0) return 0;
    const cut = this.#layers[this.#layers.length - k];
    this.#layers.length -= k;
    this.#log.length = cut;
    this.#rebuild();
    return k;
  }

  query(a, b) {
    if (!isId(a) || !isId(b)) {
      throw new BusError(INVALID_INPUT, 'query requires non-empty string a/b');
    }
    if (!this.#events.has(a)) {
      throw new BusError(INVALID_INPUT, `query endpoint not observed: ${a}`);
    }
    if (!this.#events.has(b)) {
      throw new BusError(INVALID_INPUT, `query endpoint not observed: ${b}`);
    }
    if (a === b) return REACHABLE;
    if (this.#reaches(a, b)) return REACHABLE;
    if (this.#reaches(b, a)) return NOT_REACHABLE;
    return this.#events.get(a).ts === this.#events.get(b).ts ? CONCURRENT : UNDECIDED;
  }

  /** Strongly connected components of size > 1; members and components sorted. */
  scc() {
    const ids = [...this.#events.keys()].sort();
    const adj = this.#adj;

    // Kosaraju pass 1: finishing order on G (iterative).
    const visited = new Set();
    const order = [];
    for (const start of ids) {
      if (visited.has(start)) continue;
      const stack = [[start, false]];
      while (stack.length > 0) {
        const [v, expanded] = stack.pop();
        if (expanded) {
          order.push(v);
          continue;
        }
        if (visited.has(v)) continue;
        visited.add(v);
        stack.push([v, true]);
        for (const w of adj.get(v) ?? []) {
          if (!visited.has(w)) stack.push([w, false]);
        }
      }
    }

    // Reverse graph.
    const radj = new Map(ids.map((id) => [id, []]));
    for (const [v, outs] of adj) {
      for (const w of outs) radj.get(w).push(v);
    }

    // Kosaraju pass 2: components on reverse graph in reverse finishing order.
    const seen = new Set();
    const components = [];
    for (let i = order.length - 1; i >= 0; i--) {
      const start = order[i];
      if (seen.has(start)) continue;
      const comp = [];
      const stack = [start];
      seen.add(start);
      while (stack.length > 0) {
        const v = stack.pop();
        comp.push(v);
        for (const w of radj.get(v)) {
          if (!seen.has(w)) {
            seen.add(w);
            stack.push(w);
          }
        }
      }
      if (comp.length > 1) {
        comp.sort();
        components.push(comp);
      }
    }
    components.sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0));
    return components;
  }

  /** Sorted list of observed event ids (inspection helper). */
  eventIds() {
    return [...this.#events.keys()].sort();
  }

  /** Sorted list of causal edges as [a, b] pairs (inspection helper). */
  edges() {
    const out = [];
    for (const [a, outs] of this.#adj) {
      for (const b of outs) out.push([a, b]);
    }
    out.sort((p, q) => (p[0] === q[0] ? (p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0) : p[0] < q[0] ? -1 : 1));
    return out;
  }

  ts(id) {
    const ev = this.#events.get(id);
    if (!ev) throw new BusError(INVALID_INPUT, `event not observed: ${id}`);
    return ev.ts;
  }

  #applyObserve({ id, ts, node }) {
    this.#events.set(id, { id, ts, node });
    if (!this.#adj.has(id)) this.#adj.set(id, new Set());
  }

  #applyLink({ a, b }) {
    this.#adj.get(a).add(b);
  }

  #rebuild() {
    this.#events.clear();
    this.#adj.clear();
    for (const entry of this.#log) {
      if (entry.op === 'observe') this.#applyObserve(entry);
      else this.#applyLink(entry);
    }
  }

  #reaches(from, to) {
    const seen = new Set([from]);
    const queue = [from];
    for (let i = 0; i < queue.length; i++) {
      for (const next of this.#adj.get(queue[i]) ?? []) {
        if (next === to) return true;
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return false;
  }
}
