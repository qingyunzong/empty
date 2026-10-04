import { createHash } from 'node:crypto';

export const EXIT = { OK: 0, OTHER: 1, VALIDATION: 2, PENDING: 3, CERT: 7 };

export class LotError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'LotError';
    this.code = code;
    this.details = details;
  }
}

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function toTime(ts) {
  if (typeof ts === 'number') return ts;
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) throw new LotError(EXIT.VALIDATION, `invalid timestamp: ${ts}`);
  return parsed;
}

export function makeLot({ id, mass, unit = 'kg', site, seq, createdAt, status = 'open' }) {
  if (!id) throw new LotError(EXIT.VALIDATION, 'lot id required');
  if (!(mass > 0)) throw new LotError(EXIT.VALIDATION, `lot ${id}: mass must be > 0`);
  return { kind: 'lot', id, mass, unit, status, createdAt, site, seq };
}

export function makeEvent({ op, inputs, outputs, ts, site, seq }) {
  if (!['merge', 'split', 'relabel'].includes(op)) {
    throw new LotError(EXIT.VALIDATION, `unknown op: ${op}`);
  }
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new LotError(EXIT.VALIDATION, 'event needs at least one input');
  }
  if (!Array.isArray(outputs) || outputs.length === 0) {
    throw new LotError(EXIT.VALIDATION, 'event needs at least one output');
  }
  for (const end of [...inputs, ...outputs]) {
    if (!end.lot || !(end.mass > 0)) {
      throw new LotError(EXIT.VALIDATION, 'event endpoints need lot and mass > 0');
    }
  }
  const body = { op, inputs, outputs, ts, site, seq };
  return { kind: 'event', id: sha256(canonical(body)), ...body };
}

export function edgeId(eventId, from, to) {
  return sha256(canonical({ eventId, from, to }));
}

export function eventEdges(event) {
  const edges = [];
  const base = { event: event.id, op: event.op, ts: event.ts, site: event.site, seq: event.seq };
  if (event.op === 'merge') {
    const to = event.outputs[0].lot;
    for (const input of event.inputs) {
      edges.push({ id: edgeId(event.id, input.lot, to), from: input.lot, to, mass: input.mass, ...base });
    }
  } else {
    const from = event.inputs[0].lot;
    for (const output of event.outputs) {
      edges.push({ id: edgeId(event.id, from, output.lot), from, to: output.lot, mass: output.mass, ...base });
    }
  }
  return edges;
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

export class Graph {
  constructor({ tol = 1e-9 } = {}) {
    this.tol = tol;
    this.lots = new Map(); // id -> lot record
    this.events = new Map(); // id -> applied event
    this.edges = new Map(); // id -> edge
    this.children = new Map(); // from lot -> Set(edgeId)
    this.parents = new Map(); // to lot -> Set(edgeId)
    this.pendingEvents = new Map(); // id -> event awaiting unknown lots
  }

  withinTol(a, b) {
    return Math.abs(a - b) <= Math.max(this.tol, this.tol * Math.max(Math.abs(a), Math.abs(b)));
  }

  addLot(lot) {
    const existing = this.lots.get(lot.id);
    if (existing) {
      if (existing.mass !== lot.mass || existing.unit !== lot.unit) {
        throw new LotError(EXIT.VALIDATION, `conflicting lot record: ${lot.id}`);
      }
      return false; // idempotent
    }
    this.lots.set(lot.id, { ...lot });
    return true;
  }

  hasRecord(rec) {
    return rec.kind === 'lot' ? this.lots.has(rec.id) : this.events.has(rec.id) || this.pendingEvents.has(rec.id);
  }

  consumed(lotId) {
    let total = 0;
    for (const eid of this.children.get(lotId) ?? []) total += this.edges.get(eid).mass;
    return total;
  }

  remaining(lotId) {
    const lot = this.lots.get(lotId);
    return lot.mass - this.consumed(lotId);
  }

  reachable(fromId, toId) {
    // can fromId reach toId following child edges?
    if (fromId === toId) return true;
    const seen = new Set([fromId]);
    const stack = [fromId];
    while (stack.length) {
      const node = stack.pop();
      for (const eid of this.children.get(node) ?? []) {
        const next = this.edges.get(eid).to;
        if (next === toId) return true;
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return false;
  }

  unknownEndpoints(event) {
    const unknown = [];
    for (const end of [...event.inputs, ...event.outputs]) {
      if (!this.lots.has(end.lot) && !unknown.includes(end.lot)) unknown.push(end.lot);
    }
    // outputs are created by the event itself; only inputs can block
    return unknown.filter((id) => event.inputs.some((i) => i.lot === id));
  }

  applyEvent(event) {
    if (this.events.has(event.id) || this.pendingEvents.has(event.id)) return { applied: false, duplicate: true };

    const { op } = event;
    if (op === 'merge' && event.outputs.length !== 1) {
      throw new LotError(EXIT.VALIDATION, 'merge requires exactly one output');
    }
    if (op === 'split' && event.inputs.length !== 1) {
      throw new LotError(EXIT.VALIDATION, 'split requires exactly one input');
    }
    if (op === 'relabel') {
      if (event.inputs.length !== 1 || event.outputs.length !== 1) {
        throw new LotError(EXIT.VALIDATION, 'relabel requires exactly one input and one output');
      }
      if (!this.withinTol(event.inputs[0].mass, event.outputs[0].mass)) {
        throw new LotError(EXIT.VALIDATION, 'relabel must preserve mass');
      }
    }

    const sumIn = sum(event.inputs.map((i) => i.mass));
    const sumOut = sum(event.outputs.map((o) => o.mass));
    if (!this.withinTol(sumIn, sumOut)) {
      throw new LotError(EXIT.VALIDATION, 'conservation violation', { sumIn, sumOut, tol: this.tol });
    }

    const unknown = this.unknownEndpoints(event);
    if (unknown.length > 0) {
      this.pendingEvents.set(event.id, event);
      return { applied: false, pending: unknown };
    }

    const eventTime = toTime(event.ts);
    for (const input of event.inputs) {
      const lot = this.lots.get(input.lot);
      if (lot.status === 'closed') {
        throw new LotError(EXIT.VALIDATION, `lot ${input.lot} is closed`);
      }
      if (input.mass - this.remaining(input.lot) > Math.max(this.tol, this.tol * lot.mass)) {
        throw new LotError(EXIT.VALIDATION, `lot ${input.lot} over-consumed`, {
          requested: input.mass,
          remaining: this.remaining(input.lot),
        });
      }
      if (eventTime < toTime(lot.createdAt)) {
        throw new LotError(EXIT.VALIDATION, `event ts precedes createdAt of ${input.lot}`);
      }
      for (const out of event.outputs) {
        if (lot.unit && out.unit && lot.unit !== out.unit) {
          throw new LotError(EXIT.VALIDATION, `unit mismatch: ${lot.unit} vs ${out.unit}`);
        }
      }
    }

    for (const output of event.outputs) {
      if (this.lots.has(output.lot)) {
        const cyclic = event.inputs.some((i) => this.reachable(output.lot, i.lot));
        if (cyclic) {
          throw new LotError(EXIT.VALIDATION, 'CYCLE: output lot is an ancestor of an input', { output: output.lot });
        }
        throw new LotError(EXIT.VALIDATION, `output lot already exists: ${output.lot}`);
      }
    }

    const edges = eventEdges(event);
    for (const edge of edges) {
      if (this.reachable(edge.to, edge.from)) {
        throw new LotError(EXIT.VALIDATION, 'CYCLE: edge would close a cycle', { from: edge.from, to: edge.to });
      }
    }

    // commit
    const unit = this.lots.get(event.inputs[0].lot).unit;
    for (const output of event.outputs) {
      this.addLot({
        kind: 'lot',
        id: output.lot,
        mass: output.mass,
        unit,
        status: 'open',
        createdAt: event.ts,
        site: event.site,
        seq: event.seq,
      });
    }
    for (const edge of edges) this.addEdgeRaw(edge);
    for (const input of event.inputs) {
      const lot = this.lots.get(input.lot);
      if (this.withinTol(this.remaining(input.lot), 0)) lot.status = 'consumed';
    }
    this.events.set(event.id, event);
    return { applied: true };
  }

  addEdgeRaw(edge) {
    if (this.edges.has(edge.id)) return false; // duplicate edge: idempotent
    this.edges.set(edge.id, edge);
    if (!this.children.has(edge.from)) this.children.set(edge.from, new Set());
    if (!this.parents.has(edge.to)) this.parents.set(edge.to, new Set());
    this.children.get(edge.from).add(edge.id);
    this.parents.get(edge.to).add(edge.id);
    return true;
  }

  tryResolvePending() {
    const resolved = [];
    let progress = true;
    while (progress) {
      progress = false;
      for (const [id, event] of [...this.pendingEvents]) {
        if (this.unknownEndpoints(event).length === 0) {
          this.pendingEvents.delete(id);
          this.applyEvent(event); // may throw validation now that lots are known
          resolved.push(id);
          progress = true;
        }
      }
    }
    return resolved;
  }

  pending() {
    const lots = new Set();
    for (const event of this.pendingEvents.values()) {
      for (const id of this.unknownEndpoints(event)) lots.add(id);
    }
    return { events: [...this.pendingEvents.keys()], lots: [...lots] };
  }

  ancestry(rootId) {
    const lots = new Set();
    const edges = new Set();
    const stack = [rootId];
    while (stack.length) {
      const node = stack.pop();
      if (lots.has(node)) continue;
      lots.add(node);
      for (const eid of this.parents.get(node) ?? []) {
        const edge = this.edges.get(eid);
        edges.add(eid);
        stack.push(edge.from);
      }
    }
    return { lots, edges };
  }

  pathsTo(rootId) {
    const paths = [];
    const walk = (node, suffix) => {
      const preds = this.parents.get(node);
      if (!preds || preds.size === 0) {
        paths.push([node, ...suffix]);
        return;
      }
      for (const eid of preds) {
        walk(this.edges.get(eid).from, [node, ...suffix]);
      }
    };
    walk(rootId, []);
    return paths;
  }
}
