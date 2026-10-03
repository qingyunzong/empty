// Input validation and model construction.
// Any invalid input (bad quantities, broken references, cycles, ...) raises
// InputError, which the CLI maps to exit code 2.

export class InputError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'InputError';
    this.details = details;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;
const isPosInt = (v) => Number.isInteger(v) && v > 0;

export const STATUSES = ['released', 'quarantined'];

function validateCommon(batch) {
  if (typeof batch !== 'object' || batch === null || Array.isArray(batch)) {
    throw new InputError('each batch must be an object');
  }
  if (typeof batch.id !== 'string' || batch.id.length === 0) {
    throw new InputError('batch.id must be a non-empty string');
  }
  if (batch.status !== undefined && !STATUSES.includes(batch.status)) {
    throw new InputError(`batch ${batch.id}: status must be one of ${STATUSES.join(', ')}`);
  }
  if (!isValidDate(batch.expiry)) {
    throw new InputError(`batch ${batch.id}: expiry must be a valid YYYY-MM-DD date`);
  }
}

export function parseModel(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new InputError('input must be a JSON object');
  }
  const { batches, budget = 100000 } = input;
  if (!Array.isArray(batches)) throw new InputError('batches must be an array');
  if (!isPosInt(budget)) throw new InputError('budget must be a positive integer');

  const byId = new Map();
  for (const raw of batches) {
    validateCommon(raw);
    const b = { status: 'released', ...raw };
    if (byId.has(b.id)) throw new InputError(`duplicate batch id: ${b.id}`);
    if (b.kind === 'material') {
      if (!isNonNegInt(b.quantity)) {
        throw new InputError(`batch ${b.id}: quantity must be a non-negative integer`, { field: 'quantity', value: b.quantity });
      }
    } else if (b.kind === 'production') {
      if (typeof b.line !== 'string' || b.line.length === 0) {
        throw new InputError(`batch ${b.id}: line must be a non-empty string`);
      }
      if (!isValidDate(b.start) || !isValidDate(b.end) || b.start > b.end) {
        throw new InputError(`batch ${b.id}: invalid production window [start, end]`);
      }
      if (!isPosInt(b.outputQty)) {
        throw new InputError(`batch ${b.id}: outputQty must be a positive integer`, { field: 'outputQty', value: b.outputQty });
      }
      if (!isNonNegInt(b.loss)) {
        throw new InputError(`batch ${b.id}: loss must be a non-negative integer`, { field: 'loss', value: b.loss });
      }
      if (!Array.isArray(b.candidates)) {
        throw new InputError(`batch ${b.id}: candidates must be an array of batch ids`);
      }
      if (new Set(b.candidates).size !== b.candidates.length) {
        throw new InputError(`batch ${b.id}: duplicate candidate ids`);
      }
    } else {
      throw new InputError(`batch ${b.id}: kind must be "material" or "production"`);
    }
    byId.set(b.id, b);
  }

  // Resolve candidate references (broken references -> InputError).
  const productions = [];
  for (const b of byId.values()) {
    if (b.kind !== 'production') continue;
    for (const c of b.candidates) {
      if (c === b.id) throw new InputError(`batch ${b.id}: batch cannot be its own candidate`);
      if (!byId.has(c)) throw new InputError(`batch ${b.id}: broken candidate reference: ${c}`);
    }
    productions.push(b);
  }

  // Topological order of production batches over production->production
  // candidate edges (Kahn). A cycle is a structural error.
  const prodIds = new Set(productions.map((p) => p.id));
  const indeg = new Map(productions.map((p) => [p.id, 0]));
  const adj = new Map(productions.map((p) => [p.id, []]));
  for (const p of productions) {
    for (const c of p.candidates) {
      if (!prodIds.has(c)) continue;
      indeg.set(p.id, indeg.get(p.id) + 1);
      adj.get(c).push(p.id);
    }
  }
  const queue = productions.filter((p) => indeg.get(p.id) === 0).map((p) => p.id);
  const order = [];
  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    for (const next of adj.get(id)) {
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== productions.length) {
    const cyclic = productions.filter((p) => !order.includes(p.id)).map((p) => p.id);
    throw new InputError(`candidate graph has a cycle involving: ${cyclic.join(', ')}`);
  }

  return { batches: byId, productions, order, budget };
}
