import { checkCirculation } from './circulation.js';

export class ClearingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ClearingError';
    this.code = code;
  }
}

function assertName(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ClearingError('INVALID_COMMAND', `"${field}" must be a non-empty string`);
  }
}

function assertBound(value, field) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ClearingError('INVALID_BOUNDS', `"${field}" must be an integer, got ${JSON.stringify(value)}`);
  }
  if (value < 0) {
    throw new ClearingError('NEGATIVE_CAPACITY', `"${field}" must be >= 0, got ${value}`);
  }
}

/**
 * A clearing network of bounded settlement edges. Every mutation is logged
 * as an event with a caller-supplied id; undo/redo operate by event id and
 * the network state is rebuilt by replaying the applied events.
 */
export class ClearingNetwork {
  constructor() {
    this.events = [];
    this.edges = new Map();
    this.nodes = new Set();
  }

  #assertFreshEvent(eventId) {
    assertName(eventId, 'event');
    if (this.events.some((e) => e.event === eventId)) {
      throw new ClearingError('DUPLICATE_EVENT', `duplicate event id "${eventId}"`);
    }
  }

  #commit(kind, payload) {
    this.#assertFreshEvent(payload.event);
    while (this.events.length > 0 && !this.events[this.events.length - 1].applied) {
      this.events.pop();
    }
    this.events.push({ ...payload, kind, applied: true });
    this.#rebuild();
  }

  #rebuild() {
    this.edges = new Map();
    for (const event of this.events) {
      if (!event.applied) continue;
      if (event.kind === 'add-edge') {
        this.edges.set(event.id, {
          id: event.id, from: event.from, to: event.to,
          lower: event.lower, upper: event.upper,
        });
      } else if (event.kind === 'update-edge') {
        const edge = this.edges.get(event.id);
        if (event.lower !== undefined) edge.lower = event.lower;
        if (event.upper !== undefined) edge.upper = event.upper;
      } else if (event.kind === 'remove-edge') {
        this.edges.delete(event.id);
      }
    }
    this.nodes = new Set();
    for (const edge of this.edges.values()) {
      this.nodes.add(edge.from);
      this.nodes.add(edge.to);
    }
  }

  addEdge(eventId, spec) {
    const { id, from, to, lower, upper } = spec ?? {};
    assertName(id, 'id');
    assertName(from, 'from');
    assertName(to, 'to');
    assertBound(lower, 'lower');
    assertBound(upper, 'upper');
    if (lower > upper) {
      throw new ClearingError('INVALID_BOUNDS', `lower bound ${lower} exceeds upper bound ${upper}`);
    }
    if (this.edges.has(id)) {
      throw new ClearingError('EDGE_EXISTS', `edge "${id}" already exists`);
    }
    this.#commit('add-edge', { event: eventId, id, from, to, lower, upper });
    return this.status();
  }

  updateEdge(eventId, id, changes) {
    assertName(id, 'id');
    const edge = this.edges.get(id);
    if (!edge) {
      throw new ClearingError('UNKNOWN_EDGE', `unknown edge "${id}"`);
    }
    const { lower, upper } = changes ?? {};
    if (lower === undefined && upper === undefined) {
      throw new ClearingError('INVALID_COMMAND', 'update-edge requires "lower" and/or "upper"');
    }
    if (lower !== undefined) assertBound(lower, 'lower');
    if (upper !== undefined) assertBound(upper, 'upper');
    const nextLower = lower ?? edge.lower;
    const nextUpper = upper ?? edge.upper;
    if (nextLower > nextUpper) {
      throw new ClearingError('INVALID_BOUNDS', `lower bound ${nextLower} exceeds upper bound ${nextUpper}`);
    }
    const payload = { event: eventId, id };
    if (lower !== undefined) payload.lower = lower;
    if (upper !== undefined) payload.upper = upper;
    this.#commit('update-edge', payload);
    return this.status();
  }

  removeEdge(eventId, id) {
    assertName(id, 'id');
    if (!this.edges.has(id)) {
      throw new ClearingError('UNKNOWN_EDGE', `unknown edge "${id}"`);
    }
    this.#commit('remove-edge', { event: eventId, id });
    return this.status();
  }

  undo(eventId) {
    assertName(eventId, 'id');
    const last = [...this.events].reverse().find((e) => e.applied);
    if (!last) {
      throw new ClearingError('NOTHING_TO_UNDO', 'no applied event to undo');
    }
    if (last.event !== eventId) {
      throw new ClearingError('UNDO_MISMATCH',
        `cannot undo "${eventId}": most recent applied event is "${last.event}"`);
    }
    last.applied = false;
    this.#rebuild();
    return this.status();
  }

  redo(eventId) {
    assertName(eventId, 'id');
    const next = this.events.find((e) => !e.applied);
    if (!next) {
      throw new ClearingError('NOTHING_TO_REDO', 'no undone event to redo');
    }
    if (next.event !== eventId) {
      throw new ClearingError('REDO_MISMATCH',
        `cannot redo "${eventId}": next redoable event is "${next.event}"`);
    }
    next.applied = true;
    this.#rebuild();
    return this.status();
  }

  status() {
    const nodes = [...this.nodes].sort();
    const edges = [...this.edges.values()]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return checkCirculation(nodes, edges);
  }

  nodeFlow(id) {
    assertName(id, 'id');
    if (!this.nodes.has(id)) {
      throw new ClearingError('UNKNOWN_NODE', `unknown node "${id}"`);
    }
    let lowerIn = 0;
    let lowerOut = 0;
    for (const edge of this.edges.values()) {
      if (edge.to === id) lowerIn += edge.lower;
      if (edge.from === id) lowerOut += edge.lower;
    }
    const result = { node: id, lowerBoundIn: lowerIn, lowerBoundOut: lowerOut, imbalance: lowerIn - lowerOut };
    const status = this.status();
    if (status.feasible) {
      let inflow = 0;
      let outflow = 0;
      for (const edge of this.edges.values()) {
        if (edge.to === id) inflow += status.flow[edge.id];
        if (edge.from === id) outflow += status.flow[edge.id];
      }
      result.inflow = inflow;
      result.outflow = outflow;
    }
    return result;
  }
}
