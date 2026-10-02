// Causal history over events with local intervals [a, b] and exact rational
// clock corrections f(t) = c0 + c1*t + c2*t^2.

import { Frac } from './rational.js';

export class HistoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HistoryError';
    this.code = code;
  }
}

const MAX_LINEARIZATION_EVENTS = 7;

// Corrected global interval of f over [a, b]. Includes the vertex
// t* = -c1 / (2*c2) whenever c2 != 0 and t* lies inside [a, b].
export function correctedInterval(a, b, c0, c1, c2) {
  const evaluate = (t) => c0.add(c1.mul(t)).add(c2.mul(t).mul(t));
  const points = [
    { t: a, v: evaluate(a) },
    { t: b, v: evaluate(b) },
  ];
  let vertex = null;
  if (!c2.isZero()) {
    const tStar = c1.neg().div(c2.mul(new Frac(2n)));
    if (tStar.ge(a) && tStar.le(b)) {
      vertex = { t: tStar, v: evaluate(tStar) };
      points.push(vertex);
    }
  }
  let lo = points[0].v;
  let hi = points[0].v;
  for (const p of points) {
    if (p.v.lt(lo)) lo = p.v;
    if (p.v.gt(hi)) hi = p.v;
  }
  return { lo, hi, vertex };
}

function serializeInterval(event, interval) {
  return {
    id: event.id,
    a: event.a.toString(),
    b: event.b.toString(),
    lo: interval.lo.toString(),
    hi: interval.hi.toString(),
    vertex: interval.vertex
      ? { t: interval.vertex.t.toString(), v: interval.vertex.v.toString() }
      : null,
  };
}

export class CausalHistory {
  constructor() {
    this.ops = [];
    this.redoStack = [];
    this.events = new Map();
    this.constraints = [];
  }

  _reset() {
    this.events = new Map();
    this.constraints = [];
  }

  _rebuild() {
    this._reset();
    for (const op of this.ops) this._apply(op);
  }

  _apply(op) {
    if (op.type === 'add_event') {
      this.events.set(op.id, {
        id: op.id,
        a: op.a,
        b: op.b,
        f: op.f,
      });
    } else if (op.type === 'correct') {
      this.events.get(op.id).f = op.f;
    } else if (op.type === 'add_constraint') {
      this.constraints.push({ before: op.before, after: op.after });
    }
  }

  _commit(op) {
    // Validation happens before this point; a committed op always applies.
    this._apply(op);
    this.ops.push(op);
    this.redoStack = [];
  }

  addEvent({ id, a, b, f }) {
    if (typeof id !== 'string' || id === '') {
      throw new HistoryError('E_RANGE', 'event id must be a non-empty string');
    }
    if (this.events.has(id)) {
      throw new HistoryError('E_DUPLICATE', `event already exists: ${id}`);
    }
    const ra = Frac.parse(a);
    const rb = Frac.parse(b);
    if (ra.gt(rb)) {
      throw new HistoryError('E_RANGE', `a > b for event ${id}`);
    }
    const coeffs = parsePolynomial(f);
    this._commit({ type: 'add_event', id, a: ra, b: rb, f: coeffs });
    return this.describeEvent(id);
  }

  correct({ id, f }) {
    if (!this.events.has(id)) {
      throw new HistoryError('E_UNKNOWN_EVENT', `unknown event: ${id}`);
    }
    const coeffs = parsePolynomial(f); // throws before any state change
    this._commit({ type: 'correct', id, f: coeffs });
    return this.describeEvent(id);
  }

  addConstraint({ before, after }) {
    for (const id of [before, after]) {
      if (!this.events.has(id)) {
        throw new HistoryError('E_UNKNOWN_EVENT', `unknown event: ${id}`);
      }
    }
    this._commit({ type: 'add_constraint', before, after });
    return { before, after };
  }

  undo() {
    if (this.ops.length === 0) {
      throw new HistoryError('E_NOOP', 'nothing to undo');
    }
    this.redoStack.push(this.ops.pop());
    this._rebuild();
    return { remaining: this.ops.length };
  }

  redo() {
    if (this.redoStack.length === 0) {
      throw new HistoryError('E_NOOP', 'nothing to redo');
    }
    const op = this.redoStack.pop();
    this._apply(op);
    this.ops.push(op);
    return { applied: this.ops.length };
  }

  intervalOf(id) {
    const event = this.events.get(id);
    if (!event) {
      throw new HistoryError('E_UNKNOWN_EVENT', `unknown event: ${id}`);
    }
    const [c0, c1, c2] = event.f;
    return correctedInterval(event.a, event.b, c0, c1, c2);
  }

  describeEvent(id) {
    const event = this.events.get(id);
    if (!event) {
      throw new HistoryError('E_UNKNOWN_EVENT', `unknown event: ${id}`);
    }
    return serializeInterval(event, this.intervalOf(id));
  }

  // Directed edges: interval orderings (hi_i < lo_j) plus explicit constraints.
  _edges() {
    const ids = [...this.events.keys()];
    const intervals = new Map(ids.map((id) => [id, this.intervalOf(id)]));
    const edges = [];
    for (const x of ids) {
      for (const y of ids) {
        if (x === y) continue;
        const ix = intervals.get(x);
        const iy = intervals.get(y);
        if (ix.hi.lt(iy.lo)) {
          edges.push({
            type: 'interval',
            from: x,
            to: y,
            fromHi: ix.hi.toString(),
            toLo: iy.lo.toString(),
          });
        }
      }
    }
    for (const c of this.constraints) {
      edges.push({ type: 'constraint', from: c.before, to: c.after });
    }
    return { ids, intervals, edges };
  }

  _findPath(from, to, edges) {
    const adjacency = new Map();
    for (const e of edges) {
      if (!adjacency.has(e.from)) adjacency.set(e.from, []);
      adjacency.get(e.from).push(e);
    }
    const visited = new Set([from]);
    const queue = [[from, []]];
    while (queue.length > 0) {
      const [node, path] = queue.shift();
      for (const edge of adjacency.get(node) ?? []) {
        if (edge.to === to) return [...path, edge];
        if (!visited.has(edge.to)) {
          visited.add(edge.to);
          queue.push([edge.to, [...path, edge]]);
        }
      }
    }
    return null;
  }

  relation(xId, yId) {
    if (xId === yId) {
      throw new HistoryError('E_RANGE', 'cannot relate an event to itself');
    }
    const { intervals, edges } = this._edges();
    if (!intervals.has(xId) || !intervals.has(yId)) {
      throw new HistoryError('E_UNKNOWN_EVENT', 'unknown event in query');
    }
    const forward = this._findPath(xId, yId, edges);
    const backward = this._findPath(yId, xId, edges);
    if (forward && backward) {
      throw new HistoryError(
        'E_UNSAT',
        'constraints and interval orderings are contradictory',
      );
    }
    const ix = intervals.get(xId);
    const iy = intervals.get(yId);
    const eventInfo = () => ({
      x: serializeInterval(this.events.get(xId), ix),
      y: serializeInterval(this.events.get(yId), iy),
    });
    if (forward) {
      return {
        relation: 'before',
        certificate: { kind: forward.length === 1 && forward[0].type === 'interval' ? 'interval' : 'chain', events: eventInfo(), chain: forward },
      };
    }
    if (backward) {
      return {
        relation: 'after',
        certificate: { kind: backward.length === 1 && backward[0].type === 'interval' ? 'interval' : 'chain', events: eventInfo(), chain: backward },
      };
    }
    const lo = ix.lo.gt(iy.lo) ? ix.lo : iy.lo;
    const hi = ix.hi.lt(iy.hi) ? ix.hi : iy.hi;
    return {
      relation: 'concurrent',
      certificate: {
        kind: 'overlap',
        events: eventInfo(),
        overlap: { lo: lo.toString(), hi: hi.toString() },
      },
    };
  }

  linearizations() {
    const { ids, edges } = this._edges();
    if (ids.length > MAX_LINEARIZATION_EVENTS) {
      throw new HistoryError(
        'E_TOO_MANY',
        `linearizations supported for n <= ${MAX_LINEARIZATION_EVENTS}`,
      );
    }
    const sorted = [...ids].sort();
    const preds = new Map(sorted.map((id) => [id, new Set()]));
    for (const e of edges) preds.get(e.to).add(e.from);
    const results = [];
    const placed = new Set();
    const order = [];
    const visit = () => {
      if (order.length === sorted.length) {
        results.push([...order]);
        return;
      }
      for (const id of sorted) {
        if (placed.has(id)) continue;
        let ready = true;
        for (const p of preds.get(id)) {
          if (!placed.has(p)) {
            ready = false;
            break;
          }
        }
        if (!ready) continue;
        placed.add(id);
        order.push(id);
        visit();
        placed.delete(id);
        order.pop();
      }
    };
    visit();
    if (results.length === 0) {
      throw new HistoryError('E_UNSAT', 'no feasible linearization exists');
    }
    return { count: results.length, linearizations: results };
  }

  snapshot() {
    const events = [...this.events.keys()]
      .sort()
      .map((id) => this.describeEvent(id));
    return { events, constraints: this.constraints.map((c) => ({ ...c })) };
  }
}

function parsePolynomial(f) {
  if (!Array.isArray(f) || f.length !== 3) {
    throw new HistoryError(
      'E_RATIONAL',
      'polynomial must be [c0, c1, c2]',
    );
  }
  return f.map((c) => Frac.parse(c));
}
