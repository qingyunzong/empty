import { LimError, E_TYPE } from './errors.js';

const KINDS = ['reserve', 'confirm', 'release'];

// Normalize a JSON history into internal operation records.
// An operation has an invoke/response interval on a logical clock;
// a missing response means the operation is PENDING (never treated as failed).
export function normalizeHistory(json, source = 'history') {
  const raw = Array.isArray(json) ? json : json && json.history;
  if (!Array.isArray(raw)) {
    throw new LimError(E_TYPE, `${source}: expected an array of operations (or { "history": [...] })`);
  }
  const seen = new Set();
  return raw.map((e, idx) => {
    const where = `${source}[${idx}]`;
    if (e === null || typeof e !== 'object') throw new LimError(E_TYPE, `${where}: expected an object`);
    const id = e.id ?? e.name;
    const kind = e.op ?? e.kind;
    if (typeof id !== 'string' || id === '') throw new LimError(E_TYPE, `${where}: missing string 'id'`);
    if (seen.has(id)) throw new LimError(E_TYPE, `${where}: duplicate operation id '${id}'`);
    seen.add(id);
    if (!KINDS.includes(kind)) {
      throw new LimError(E_TYPE, `${where} ('${id}'): unknown operation kind '${kind}'`);
    }
    if (typeof e.order !== 'string' || e.order === '') {
      throw new LimError(E_TYPE, `${where} ('${id}'): missing string 'order'`);
    }
    if (!Number.isInteger(e.invoke) || e.invoke < 0) {
      throw new LimError(E_TYPE, `${where} ('${id}'): 'invoke' must be a non-negative integer (logical clock)`);
    }
    let response = null;
    let result = null;
    if (e.response !== null && e.response !== undefined && e.pending !== true) {
      if (!Number.isInteger(e.response) || e.response < e.invoke) {
        throw new LimError(E_TYPE, `${where} ('${id}'): 'response' must be an integer >= invoke`);
      }
      response = e.response;
      if (e.result !== 'ok' && e.result !== 'fail') {
        throw new LimError(E_TYPE, `${where} ('${id}'): completed operation needs result "ok" or "fail"`);
      }
      result = e.result;
    }
    return { id, kind, order: e.order, invoke: e.invoke, response, result };
  });
}

// Static type guarantees over the operation stream:
//  - confirm may only consume an existing reserve of the same order
//  - release may only consume an existing reserve and must not be duplicated
export function typecheckHistory(model, ops) {
  const reserveOrders = new Set(ops.filter((o) => o.kind === 'reserve').map((o) => o.order));
  const releaseCount = new Map();
  for (const op of ops) {
    if (!model.orders.has(op.order)) {
      throw new LimError(E_TYPE, `op '${op.id}' references undeclared order '${op.order}'`);
    }
    if (op.kind === 'confirm' && !reserveOrders.has(op.order)) {
      throw new LimError(E_TYPE, `confirm '${op.id}' has no matching reserve for order '${op.order}'`);
    }
    if (op.kind === 'release') {
      if (!reserveOrders.has(op.order)) {
        throw new LimError(E_TYPE, `release '${op.id}' has no matching reserve for order '${op.order}'`);
      }
      const c = (releaseCount.get(op.order) ?? 0) + 1;
      releaseCount.set(op.order, c);
      if (c > 1) throw new LimError(E_TYPE, `duplicate release of order '${op.order}' (op '${op.id}')`);
    }
  }
}
