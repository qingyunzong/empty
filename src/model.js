'use strict';

class KitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KitError';
    this.code = code;
  }
}

// Deterministic total order used for due dates, order ids, line numbers,
// expiries and batch ids: numbers compare numerically, everything else
// compares by its string form.
function compareValues(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function isScalar(v) {
  return typeof v === 'string' || typeof v === 'number';
}

// Directed graph of material substitutions. An edge [from, to] means
// "material `from` may be fulfilled by stock of material `to`".
// The graph must stay acyclic.
class SubstituteGraph {
  constructor(edges) {
    this.edges = [];
    this.adj = new Map();
    for (const edge of edges || []) {
      const [from, to] = edge;
      if (this.adj.get(from)?.has(to)) continue; // dedupe
      if (!this.adj.has(from)) this.adj.set(from, new Set());
      this.adj.get(from).add(to);
      this.edges.push([from, to]);
    }
    this.#assertAcyclic();
  }

  materials() {
    const out = new Set();
    for (const [from, to] of this.edges) {
      out.add(from);
      out.add(to);
    }
    return out;
  }

  // All materials that can fulfil `material`, including itself.
  reachableFrom(material) {
    const seen = new Set([material]);
    const stack = [material];
    while (stack.length > 0) {
      const cur = stack.pop();
      for (const next of this.adj.get(cur) || []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return seen;
  }

  hasPath(from, to) {
    return this.reachableFrom(from).has(to);
  }

  createsCycle(from, to) {
    return from === to || this.hasPath(to, from);
  }

  #assertAcyclic() {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();
    for (const m of this.materials()) color.set(m, WHITE);
    const visit = (node) => {
      color.set(node, GRAY);
      for (const next of this.adj.get(node) || []) {
        const c = color.get(next) ?? WHITE;
        if (c === GRAY) {
          throw new KitError('CYCLE', `substitution cycle detected involving material: ${next}`);
        }
        if (c === WHITE) visit(next);
      }
      color.set(node, BLACK);
    };
    for (const m of this.materials()) {
      if (color.get(m) === WHITE) visit(m);
    }
  }
}

function normBatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new KitError('VALIDATION', 'batch must be an object');
  }
  if (!isScalar(raw.id)) throw new KitError('VALIDATION', 'batch.id must be a string or number');
  if (typeof raw.material !== 'string' || raw.material === '') {
    throw new KitError('VALIDATION', `batch ${raw.id}: material must be a non-empty string`);
  }
  if (!Number.isInteger(raw.qty) || raw.qty < 0) {
    throw new KitError('VALIDATION', `batch ${raw.id}: qty must be a non-negative integer`);
  }
  if (!isScalar(raw.expiry)) {
    throw new KitError('VALIDATION', `batch ${raw.id}: expiry must be a string or number`);
  }
  const status = raw.status ?? 'OK';
  if (status !== 'OK' && status !== 'HOLD') {
    throw new KitError('VALIDATION', `batch ${raw.id}: status must be "OK" or "HOLD"`);
  }
  return { id: raw.id, material: raw.material, qty: raw.qty, expiry: raw.expiry, status };
}

function normOrder(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new KitError('VALIDATION', 'order must be an object');
  }
  if (!isScalar(raw.id)) throw new KitError('VALIDATION', 'order.id must be a string or number');
  if (!isScalar(raw.due)) throw new KitError('VALIDATION', `order ${raw.id}: due must be a string or number`);
  if (!Array.isArray(raw.lines)) throw new KitError('VALIDATION', `order ${raw.id}: lines must be an array`);
  const lines = raw.lines.map((line) => {
    if (!line || typeof line !== 'object' || Array.isArray(line)) {
      throw new KitError('VALIDATION', `order ${raw.id}: line must be an object`);
    }
    if (!isScalar(line.line)) {
      throw new KitError('VALIDATION', `order ${raw.id}: line.line must be a string or number`);
    }
    if (typeof line.material !== 'string' || line.material === '') {
      throw new KitError('VALIDATION', `order ${raw.id} line ${line.line}: material must be a non-empty string`);
    }
    if (!Number.isInteger(line.qty) || line.qty <= 0) {
      throw new KitError('VALIDATION', `order ${raw.id} line ${line.line}: qty must be a positive integer`);
    }
    return { line: line.line, material: line.material, qty: line.qty };
  });
  return { id: raw.id, due: raw.due, lines };
}

function normEdge(raw) {
  if (!Array.isArray(raw) || raw.length !== 2 ||
      typeof raw[0] !== 'string' || raw[0] === '' ||
      typeof raw[1] !== 'string' || raw[1] === '') {
    throw new KitError('VALIDATION', 'substitute edge must be [fromMaterial, toMaterial] non-empty strings');
  }
  return [raw[0], raw[1]];
}

function assertNoDuplicates(ids, kind) {
  const seen = new Set();
  for (const id of ids) {
    const key = `${typeof id}:${id}`;
    if (seen.has(key)) throw new KitError('DUPLICATE', `duplicate ${kind}: ${id}`);
    seen.add(key);
  }
}

// Validate and normalize the initial input document into an immutable
// (by convention) plain-object state.
function createState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new KitError('VALIDATION', 'input must be an object');
  }
  const now = input.now ?? null;
  if (now !== null && !isScalar(now)) {
    throw new KitError('VALIDATION', 'now must be a string or number');
  }
  const batches = (input.batches ?? []).map(normBatch);
  assertNoDuplicates(batches.map((b) => b.id), 'batch');
  const substitutes = (input.substitutes ?? []).map(normEdge);
  new SubstituteGraph(substitutes); // validates acyclicity
  const orders = (input.orders ?? []).map(normOrder);
  assertNoDuplicates(orders.map((o) => o.id), 'order');
  return { now, batches, substitutes, orders };
}

module.exports = {
  KitError,
  SubstituteGraph,
  compareValues,
  createState,
  normBatch,
  normOrder,
  normEdge,
};
