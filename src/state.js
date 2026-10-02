import { err, CODES } from './errors.js';

export function emptyState() {
  return {
    machines: {},     // id -> { id, calendar: [[start,end],...] } minutes
    orders: {},       // id -> { id, product, priority, ops: [{ machine, duration }] }
    changeovers: {},  // machine -> { "from>to": minutes }
    deps: {},         // opId -> [predecessor opId]  (opId = "<order>:<index>")
    budget: null,     // max allowed primary objective
    schedule: null,   // last committed schedule result
  };
}

export function opId(orderId, index) {
  return `${orderId}:${index}`;
}

export function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function validateCalendar(calendar) {
  if (!Array.isArray(calendar)) throw err(CODES.E_STATE, 'calendar must be an array of [start,end]');
  let prevEnd = -1;
  for (const win of calendar) {
    if (!Array.isArray(win) || win.length !== 2 || !(win[0] >= 0) || !(win[1] > win[0])) {
      throw err(CODES.E_STATE, `invalid calendar window: ${JSON.stringify(win)}`);
    }
    if (win[0] < prevEnd) throw err(CODES.E_STATE, 'calendar windows must be sorted and non-overlapping');
    prevEnd = win[1];
  }
}

function validateOrder(state, order) {
  if (!order || typeof order.id !== 'string' || order.id.length === 0) {
    throw err(CODES.E_STATE, 'order requires a non-empty string id');
  }
  if (typeof order.product !== 'string' || order.product.length === 0) {
    throw err(CODES.E_STATE, `order ${order.id}: product is required`);
  }
  if (!Number.isFinite(order.priority) || order.priority <= 0) {
    throw err(CODES.E_STATE, `order ${order.id}: priority must be a positive number`);
  }
  if (!Array.isArray(order.ops) || order.ops.length === 0) {
    throw err(CODES.E_STATE, `order ${order.id}: needs at least one operation`);
  }
  order.ops.forEach((op, i) => {
    if (!state.machines[op.machine]) {
      throw err(CODES.E_STATE, `order ${order.id} op ${i}: unknown machine ${op.machine}`);
    }
    if (!Number.isFinite(op.duration) || op.duration <= 0) {
      throw err(CODES.E_STATE, `order ${order.id} op ${i}: duration must be positive`);
    }
  });
}

// Build the full precedence graph: intra-order chains + explicit deps.
export function buildPrecedenceGraph(state) {
  const preds = new Map(); // opId -> Set(opId)
  const ensure = (id) => {
    if (!preds.has(id)) preds.set(id, new Set());
    return preds.get(id);
  };
  for (const order of Object.values(state.orders)) {
    order.ops.forEach((_, i) => {
      ensure(opId(order.id, i));
      if (i > 0) ensure(opId(order.id, i)).add(opId(order.id, i - 1));
    });
  }
  for (const [id, list] of Object.entries(state.deps)) {
    for (const p of list) ensure(id).add(p);
  }
  return preds;
}

// Throws E_PRECEDENCE when the graph has a cycle; returns topological order otherwise.
export function checkAcyclic(state) {
  const preds = buildPrecedenceGraph(state);
  const indeg = new Map();
  const succ = new Map();
  for (const [id, ps] of preds) {
    indeg.set(id, ps.size);
    for (const p of ps) {
      if (!succ.has(p)) succ.set(p, []);
      succ.get(p).push(id);
    }
  }
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id).sort();
  const topo = [];
  while (queue.length) {
    const id = queue.shift();
    topo.push(id);
    for (const nxt of succ.get(id) ?? []) {
      const d = indeg.get(nxt) - 1;
      indeg.set(nxt, d);
      if (d === 0) {
        queue.push(nxt);
        queue.sort();
      }
    }
  }
  if (topo.length !== preds.size) {
    throw err(CODES.E_PRECEDENCE, 'operation precedence graph contains a cycle');
  }
  return topo;
}

function knownOp(state, id) {
  const [orderId, idx] = id.split(':');
  const order = state.orders[orderId];
  return order && order.ops[Number(idx)] !== undefined;
}

// Apply one delta op in place. Assumes commit() already validated.
export function applyOp(state, op) {
  switch (op.kind) {
    case 'setMachine':
      state.machines[op.id] = deepClone(op.machine);
      break;
    case 'removeMachine':
      delete state.machines[op.id];
      break;
    case 'setOrder':
      state.orders[op.order.id] = deepClone(op.order);
      break;
    case 'removeOrder': {
      delete state.orders[op.id];
      for (const key of Object.keys(state.deps)) {
        if (key.startsWith(op.id + ':')) delete state.deps[key];
        else state.deps[key] = state.deps[key].filter((p) => !p.startsWith(op.id + ':'));
      }
      break;
    }
    case 'setChangeover': {
      const table = (state.changeovers[op.machine] ??= {});
      table[`${op.from}>${op.to}`] = op.minutes;
      break;
    }
    case 'removeChangeover': {
      const table = state.changeovers[op.machine];
      if (table) {
        delete table[`${op.from}>${op.to}`];
        if (Object.keys(table).length === 0) delete state.changeovers[op.machine];
      }
      break;
    }
    case 'setBudget':
      state.budget = op.budget;
      break;
    case 'addDep': {
      const list = (state.deps[op.op] ??= []);
      if (!list.includes(op.before)) list.push(op.before);
      list.sort();
      break;
    }
    case 'removeDep': {
      const list = state.deps[op.op];
      if (list) {
        state.deps[op.op] = list.filter((p) => p !== op.before);
        if (state.deps[op.op].length === 0) delete state.deps[op.op];
      }
      break;
    }
    case 'setSchedule':
      state.schedule = deepClone(op.schedule);
      break;
    default:
      throw err(CODES.E_STATE, `unknown delta op kind: ${op.kind}`);
  }
}

// Validate an op against the current state (before applying).
export function validateOp(state, op) {
  switch (op.kind) {
    case 'setMachine':
      if (typeof op.id !== 'string' || !op.id) throw err(CODES.E_STATE, 'machine id required');
      validateCalendar(op.machine?.calendar);
      break;
    case 'removeMachine': {
      if (!state.machines[op.id]) throw err(CODES.E_STATE, `unknown machine ${op.id}`);
      for (const order of Object.values(state.orders)) {
        if (order.ops.some((o) => o.machine === op.id)) {
          throw err(CODES.E_STATE, `machine ${op.id} still referenced by order ${order.id}`);
        }
      }
      break;
    }
    case 'setOrder':
      validateOrder(state, op.order);
      break;
    case 'removeOrder':
      if (!state.orders[op.id]) throw err(CODES.E_STATE, `unknown order ${op.id}`);
      break;
    case 'setChangeover':
      if (!state.machines[op.machine]) throw err(CODES.E_STATE, `unknown machine ${op.machine}`);
      if (!Number.isFinite(op.minutes) || op.minutes < 0) throw err(CODES.E_STATE, 'changeover minutes must be >= 0');
      break;
    case 'setBudget':
      if (op.budget !== null && (!Number.isFinite(op.budget) || op.budget < 0)) {
        throw err(CODES.E_STATE, 'budget must be null or a non-negative number');
      }
      break;
    case 'addDep': {
      if (!knownOp(state, op.op)) throw err(CODES.E_STATE, `unknown op ${op.op}`);
      if (!knownOp(state, op.before)) throw err(CODES.E_STATE, `unknown op ${op.before}`);
      if (op.op === op.before) throw err(CODES.E_PRECEDENCE, `self dependency on ${op.op}`);
      break;
    }
    case 'removeDep':
      break;
    case 'setSchedule':
      break;
    default:
      throw err(CODES.E_STATE, `unknown delta op kind: ${op.kind}`);
  }
}

// Compute the inverse of an op against the state BEFORE the op is applied.
export function inverseOp(state, op) {
  switch (op.kind) {
    case 'setMachine': {
      const prev = state.machines[op.id];
      return prev ? { kind: 'setMachine', id: op.id, machine: deepClone(prev) } : { kind: 'removeMachine', id: op.id };
    }
    case 'removeMachine':
      return { kind: 'setMachine', id: op.id, machine: deepClone(state.machines[op.id]) };
    case 'setOrder': {
      const prev = state.orders[op.order.id];
      return prev ? { kind: 'setOrder', order: deepClone(prev) } : { kind: 'removeOrder', id: op.order.id };
    }
    case 'removeOrder':
      return { kind: 'setOrder', order: deepClone(state.orders[op.id]) };
    case 'setChangeover': {
      const prev = state.changeovers[op.machine]?.[`${op.from}>${op.to}`];
      return prev === undefined
        ? { kind: 'removeChangeover', machine: op.machine, from: op.from, to: op.to }
        : { kind: 'setChangeover', machine: op.machine, from: op.from, to: op.to, minutes: prev };
    }
    case 'removeChangeover': {
      const prev = state.changeovers[op.machine]?.[`${op.from}>${op.to}`];
      return prev === undefined
        ? { kind: 'removeChangeover', machine: op.machine, from: op.from, to: op.to }
        : { kind: 'setChangeover', machine: op.machine, from: op.from, to: op.to, minutes: prev };
    }
    case 'setBudget':
      return { kind: 'setBudget', budget: state.budget ?? null };
    case 'addDep':
      return { kind: 'removeDep', op: op.op, before: op.before };
    case 'removeDep':
      return { kind: 'addDep', op: op.op, before: op.before };
    case 'setSchedule':
      return { kind: 'setSchedule', schedule: deepClone(state.schedule ?? null) };
    default:
      throw err(CODES.E_STATE, `unknown delta op kind: ${op.kind}`);
  }
}
