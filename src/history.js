// Device event causal history with exact rational quadratic clock correction.
//
// Each event has an id, a local time interval [a, b], and a correction
// polynomial f(t) = c0 + c1*t + c2*t^2 with rational coefficients.
// The corrected global interval is the exact image of [a, b] under f,
// including the vertex extremum when c2 != 0 and the vertex lies in [a, b].

import { Frac, RationalError, parseRational } from './fraction.js';

export const ERR = {
  RATIONAL: 'E_RATIONAL',
  RANGE: 'E_RANGE',
  UNKNOWN_EVENT: 'E_UNKNOWN_EVENT',
  DUPLICATE_EVENT: 'E_DUPLICATE_EVENT',
  UNSAT: 'E_UNSAT',
  TOO_LARGE: 'E_TOO_LARGE',
};

export const MAX_LINEARIZE = 7;

function fail(code, message) {
  return { ok: false, error: code, message };
}

function parsePolynomial(f) {
  let raw;
  if (Array.isArray(f)) {
    if (f.length > 3) throw new RationalError('polynomial degree must be <= 2');
    raw = [f[0] ?? 0, f[1] ?? 0, f[2] ?? 0];
  } else if (f !== null && typeof f === 'object') {
    raw = [f.c0 ?? 0, f.c1 ?? 0, f.c2 ?? 0];
  } else {
    throw new RationalError('polynomial must be {c0,c1,c2} or [c0,c1,c2]');
  }
  const [c0, c1, c2] = raw.map(parseRational);
  return { c0, c1, c2 };
}

// Exact image of [a, b] under f(t) = c0 + c1 t + c2 t^2.
// Extrema on a closed interval occur at endpoints or at the vertex
// t* = -c1 / (2 c2) when c2 != 0 and t* in [a, b].
export function correctedInterval(a, b, poly) {
  const { c0, c1, c2 } = poly;
  const evaluate = (t) => c0.add(c1.mul(t)).add(c2.mul(t).mul(t));
  const va = evaluate(a);
  const vb = evaluate(b);
  let lo = va.cmp(vb) <= 0 ? va : vb;
  let hi = va.cmp(vb) <= 0 ? vb : va;
  let vertex = null;
  if (!c2.isZero()) {
    const t = c1.neg().div(c2.mul(new Frac(2n)));
    if (t.cmp(a) >= 0 && t.cmp(b) <= 0) {
      const value = evaluate(t);
      vertex = { t, value };
      if (value.cmp(lo) < 0) lo = value;
      if (value.cmp(hi) > 0) hi = value;
    }
  }
  return { lo, hi, vertex };
}

function intervalToJSON(interval) {
  return {
    lo: interval.lo.toString(),
    hi: interval.hi.toString(),
    vertex: interval.vertex
      ? { t: interval.vertex.t.toString(), value: interval.vertex.value.toString() }
      : null,
  };
}

export class History {
  #events = new Map(); // id -> { id, a, b, poly, interval }
  #constraints = [];   // [{ before, after }]
  #undoStack = [];
  #redoStack = [];

  #record(undoFn, redoFn) {
    this.#undoStack.push({ undo: undoFn, redo: redoFn });
    this.#redoStack = [];
  }

  #eventOrFail(id) {
    const ev = this.#events.get(id);
    if (!ev) return { error: fail(ERR.UNKNOWN_EVENT, `unknown event: ${id}`) };
    return { ev };
  }

  importEvent({ id, a, b, f }) {
    if (id === undefined || id === null) return fail(ERR.RATIONAL, 'event id is required');
    id = String(id);
    if (this.#events.has(id)) return fail(ERR.DUPLICATE_EVENT, `duplicate event: ${id}`);
    let aR, bR, poly;
    try {
      aR = parseRational(a);
      bR = parseRational(b);
      poly = parsePolynomial(f);
    } catch (e) {
      if (e instanceof RationalError) return fail(ERR.RATIONAL, e.message);
      throw e;
    }
    if (aR.cmp(bR) > 0) return fail(ERR.RANGE, `a > b: ${aR} > ${bR}`);
    const interval = correctedInterval(aR, bR, poly);
    const ev = { id, a: aR, b: bR, poly, interval };
    this.#events.set(id, ev);
    this.#record(
      () => { this.#events.delete(id); },
      () => { this.#events.set(id, ev); },
    );
    return { ok: true, id, interval: intervalToJSON(interval) };
  }

  correct(id, f) {
    id = String(id);
    const { ev, error } = this.#eventOrFail(id);
    if (error) return error;
    let poly;
    try {
      poly = parsePolynomial(f);
    } catch (e) {
      // Invalid polynomial: history is left completely unchanged.
      if (e instanceof RationalError) return fail(ERR.RATIONAL, e.message);
      throw e;
    }
    const previous = { poly: ev.poly, interval: ev.interval };
    const next = { poly, interval: correctedInterval(ev.a, ev.b, poly) };
    ev.poly = next.poly;
    ev.interval = next.interval;
    this.#record(
      () => { ev.poly = previous.poly; ev.interval = previous.interval; },
      () => { ev.poly = next.poly; ev.interval = next.interval; },
    );
    return { ok: true, id, interval: intervalToJSON(next.interval) };
  }

  constrain(before, after) {
    before = String(before);
    after = String(after);
    if (!this.#events.has(before)) return fail(ERR.UNKNOWN_EVENT, `unknown event: ${before}`);
    if (!this.#events.has(after)) return fail(ERR.UNKNOWN_EVENT, `unknown event: ${after}`);
    const edge = { before, after };
    this.#constraints.push(edge);
    this.#record(
      () => { this.#constraints.splice(this.#constraints.indexOf(edge), 1); },
      () => { this.#constraints.push(edge); },
    );
    return { ok: true, constraint: { before, after } };
  }

  undo() {
    const entry = this.#undoStack.pop();
    if (!entry) return { ok: true, applied: false };
    entry.undo();
    this.#redoStack.push(entry);
    return { ok: true, applied: true };
  }

  redo() {
    const entry = this.#redoStack.pop();
    if (!entry) return { ok: true, applied: false };
    entry.redo();
    this.#undoStack.push(entry);
    return { ok: true, applied: true };
  }

  // Shortest constraint chain from -> to, or null. BFS over happens-before edges.
  #constraintChain(from, to) {
    if (from === to) return null;
    const parent = new Map([[from, null]]);
    const queue = [from];
    while (queue.length > 0) {
      const cur = queue.shift();
      for (const { before, after } of this.#constraints) {
        if (before !== cur || parent.has(after)) continue;
        parent.set(after, cur);
        if (after === to) {
          const chain = [to];
          let node = to;
          while (parent.get(node) !== null) {
            node = parent.get(node);
            chain.unshift(node);
          }
          return chain;
        }
        queue.push(after);
      }
    }
    return null;
  }

  compare(x, y) {
    x = String(x);
    y = String(y);
    const ex = this.#eventOrFail(x);
    if (ex.error) return ex.error;
    const ey = this.#eventOrFail(y);
    if (ey.error) return ey.error;
    const ix = ex.ev.interval;
    const iy = ey.ev.interval;

    const xBeforeByInterval = ix.hi.cmp(iy.lo) < 0;
    const yBeforeByInterval = iy.hi.cmp(ix.lo) < 0;
    const xChain = this.#constraintChain(x, y);
    const yChain = this.#constraintChain(y, x);

    const xBefore = xBeforeByInterval || xChain !== null;
    const yBefore = yBeforeByInterval || yChain !== null;

    if (xBefore && yBefore) {
      return fail(ERR.UNSAT, 'intervals and happens-before constraints are contradictory');
    }

    const intervalCertificate = (first, second) => ({
      kind: 'interval',
      first: { id: first, interval: intervalToJSON(first === x ? ix : iy) },
      second: { id: second, interval: intervalToJSON(second === x ? ix : iy) },
      reason: 'hi(first) < lo(second) over exact corrected intervals',
    });

    if (xBefore) {
      return {
        ok: true,
        relation: 'before',
        certificate: xChain
          ? { kind: 'chain', chain: xChain }
          : intervalCertificate(x, y),
      };
    }
    if (yBefore) {
      return {
        ok: true,
        relation: 'after',
        certificate: yChain
          ? { kind: 'chain', chain: yChain }
          : intervalCertificate(y, x),
      };
    }
    return {
      ok: true,
      relation: 'concurrent',
      certificate: {
        kind: 'overlap',
        x: { id: x, interval: intervalToJSON(ix) },
        y: { id: y, interval: intervalToJSON(iy) },
        reason: 'corrected intervals overlap and no happens-before chain orders the events',
      },
    };
  }

  // All interval-implied and explicit edges among the given ids.
  #edgesAmong(ids) {
    const seen = new Set();
    const edges = [];
    const addEdge = (u, v) => {
      const key = `${u}→${v}`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push([u, v]);
    };
    for (const { before, after } of this.#constraints) {
      if (ids.includes(before) && ids.includes(after)) addEdge(before, after);
    }
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = 0; j < ids.length; j += 1) {
        if (i === j) continue;
        const hi = this.#events.get(ids[i]).interval.hi;
        const lo = this.#events.get(ids[j]).interval.lo;
        if (hi.cmp(lo) < 0) addEdge(ids[i], ids[j]);
      }
    }
    return edges;
  }

  // Canonically enumerate every linearization consistent with interval
  // ordering and explicit happens-before constraints. Unknown (concurrent)
  // pairs are free: they appear in both orders. Only a genuine cycle in the
  // combined order yields E_UNSAT.
  linearize(ids) {
    const all = ids === undefined ? [...this.#events.keys()] : ids.map(String);
    for (const id of all) {
      if (!this.#events.has(id)) return fail(ERR.UNKNOWN_EVENT, `unknown event: ${id}`);
    }
    if (all.length > MAX_LINEARIZE) {
      return fail(ERR.TOO_LARGE, `linearization supports at most ${MAX_LINEARIZE} events`);
    }
    const edges = this.#edgesAmong(all);
    const indegree = new Map(all.map((id) => [id, 0]));
    const outgoing = new Map(all.map((id) => [id, []]));
    for (const [u, v] of edges) {
      outgoing.get(u).push(v);
      indegree.set(v, indegree.get(v) + 1);
    }
    const orders = [];
    const current = [];
    const available = all.filter((id) => indegree.get(id) === 0).sort();
    const place = (id) => {
      current.push(id);
      for (const v of outgoing.get(id)) indegree.set(v, indegree.get(v) - 1);
    };
    const remove = (id) => {
      current.pop();
      for (const v of outgoing.get(id)) indegree.set(v, indegree.get(v) + 1);
    };
    const walk = (candidates) => {
      if (current.length === all.length) {
        orders.push([...current]);
        return;
      }
      for (let i = 0; i < candidates.length; i += 1) {
        const id = candidates[i];
        place(id);
        const freed = outgoing.get(id).filter((v) => indegree.get(v) === 0);
        const next = candidates.slice(0, i).concat(candidates.slice(i + 1), freed).sort();
        walk(next);
        remove(id);
      }
    };
    walk(available);
    if (orders.length === 0) {
      return fail(ERR.UNSAT, 'interval order and happens-before constraints contain a cycle');
    }
    return { ok: true, count: orders.length, linearizations: orders };
  }

  snapshot() {
    const events = {};
    for (const [id, ev] of this.#events) {
      events[id] = {
        a: ev.a.toString(),
        b: ev.b.toString(),
        f: { c0: ev.poly.c0.toString(), c1: ev.poly.c1.toString(), c2: ev.poly.c2.toString() },
        interval: intervalToJSON(ev.interval),
      };
    }
    return { ok: true, events, constraints: this.#constraints.map((c) => ({ ...c })) };
  }
}

export function createHistory() {
  return new History();
}
