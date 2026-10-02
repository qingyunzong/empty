import crypto from 'node:crypto';
import { canonical } from './canon.js';
import { SchedError } from './errors.js';

export function emptyState() {
  return { machines: {}, orders: {}, setup: {}, schedule: null };
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function stateHash(state) {
  return crypto.createHash('sha256').update(canonical(state)).digest('hex');
}

export function validateOrder(order) {
  const ops = order.ops ?? [];
  const ids = new Set();
  for (const op of ops) {
    if (ids.has(op.id)) {
      throw new SchedError('E_PRECEDENCE', `duplicate operation id ${op.id} in order ${order.id}`);
    }
    ids.add(op.id);
  }
  const succ = new Map();
  const indeg = new Map();
  for (const op of ops) {
    for (const p of op.preds ?? []) {
      if (!ids.has(p)) {
        throw new SchedError('E_PRECEDENCE', `operation ${op.id} depends on unknown operation ${p}`);
      }
      if (!succ.has(p)) succ.set(p, []);
      succ.get(p).push(op.id);
      indeg.set(op.id, (indeg.get(op.id) ?? 0) + 1);
    }
  }
  const queue = ops.filter((o) => !(indeg.get(o.id) > 0)).map((o) => o.id);
  let seen = 0;
  while (queue.length) {
    const x = queue.pop();
    seen++;
    for (const y of succ.get(x) ?? []) {
      indeg.set(y, indeg.get(y) - 1);
      if (indeg.get(y) === 0) queue.push(y);
    }
  }
  if (seen !== ops.length) {
    throw new SchedError('E_PRECEDENCE', `cyclic precedence in order ${order.id}`);
  }
}

export function applyOp(state, op) {
  switch (op.type) {
    case 'addMachine':
      state.machines[op.machine.id] = clone(op.machine);
      break;
    case 'removeMachine':
      delete state.machines[op.id];
      break;
    case 'addOrder':
      validateOrder(op.order);
      state.orders[op.order.id] = clone(op.order);
      break;
    case 'removeOrder':
      delete state.orders[op.id];
      break;
    case 'setSetup': {
      const m = (state.setup[op.machine] ??= {});
      const f = (m[op.from] ??= {});
      if (op.time === null || op.time === undefined) {
        delete f[op.to];
        if (Object.keys(f).length === 0) delete m[op.from];
        if (Object.keys(m).length === 0) delete state.setup[op.machine];
      } else {
        f[op.to] = op.time;
      }
      break;
    }
    case 'setSchedule':
      state.schedule = op.schedule === null ? null : clone(op.schedule);
      break;
    default:
      throw new SchedError('E_STATE', `unknown state op ${op.type}`);
  }
}

export function inverseOf(state, op) {
  switch (op.type) {
    case 'addMachine':
      return { type: 'removeMachine', id: op.machine.id };
    case 'removeMachine':
      return { type: 'addMachine', machine: clone(state.machines[op.id]) };
    case 'addOrder':
      return { type: 'removeOrder', id: op.order.id };
    case 'removeOrder':
      return { type: 'addOrder', order: clone(state.orders[op.id]) };
    case 'setSetup': {
      const prior = state.setup[op.machine]?.[op.from]?.[op.to] ?? null;
      return { type: 'setSetup', machine: op.machine, from: op.from, to: op.to, time: prior };
    }
    case 'setSchedule':
      return { type: 'setSchedule', schedule: state.schedule === null ? null : clone(state.schedule) };
    default:
      throw new SchedError('E_STATE', `cannot invert state op ${op.type}`);
  }
}
