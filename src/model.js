import { createHash } from 'node:crypto';
import { InputError } from './errors.js';

export function parseJsonl(text, at) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    let obj;
    try { obj = JSON.parse(t); } catch {
      throw new InputError('E_INPUT', `${at}:${i + 1}`, 'invalid JSON line');
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new InputError('E_INPUT', `${at}:${i + 1}`, 'line must be a JSON object');
    }
    out.push({ obj, at: `${at}:${i + 1}` });
  });
  return out;
}

function needString(v, field, at) {
  if (typeof v !== 'string' || v.length === 0) {
    throw new InputError('E_INPUT', at, `field "${field}" must be a non-empty string`);
  }
  return v;
}
function needNumber(v, field, at, { min = 0, exclusiveMin = false } = {}) {
  if (typeof v !== 'number' || !Number.isFinite(v) || (exclusiveMin ? v <= min : v < min)) {
    throw new InputError('E_INPUT', at, `field "${field}" must be a number ${exclusiveMin ? '>' : '>='} ${min}`);
  }
  return v;
}

// Build a validated, fully cross-referenced dataset.
// Unknown references are INPUT errors (exit 2), never treated as infeasibility.
export function buildDataset({ orders = [], molds = [], machines = [], setups = [], operators = [] }) {
  const machineMap = new Map();
  for (const { obj, at } of machines) {
    const id = needString(obj.id, 'id', at);
    if (machineMap.has(id)) throw new InputError('E_INPUT', at, `duplicate machine "${id}"`);
    machineMap.set(id, { id, rate: needNumber(obj.rate, 'rate', at, { min: 0, exclusiveMin: true }) });
  }
  const moldMap = new Map();
  for (const { obj, at } of molds) {
    const id = needString(obj.id, 'id', at);
    if (moldMap.has(id)) throw new InputError('E_INPUT', at, `duplicate mold "${id}"`);
    const machine = needString(obj.machine, 'machine', at);
    if (!machineMap.has(machine)) throw new InputError('E_INPUT', at, `mold "${id}" references unknown machine "${machine}"`);
    moldMap.set(id, { id, machine });
  }
  const operatorMap = new Map();
  for (const { obj, at } of operators) {
    const id = needString(obj.id, 'id', at);
    if (operatorMap.has(id)) throw new InputError('E_INPUT', at, `duplicate operator "${id}"`);
    operatorMap.set(id, { id });
  }
  const orderMap = new Map();
  for (const { obj, at } of orders) {
    const o = validateOrder(obj, at, moldMap, operatorMap);
    if (orderMap.has(o.id)) throw new InputError('E_INPUT', at, `duplicate order "${o.id}"`);
    orderMap.set(o.id, o);
  }
  const setupMap = new Map(); // "from->to" -> minutes, "*" wildcard allowed
  for (const { obj, at } of setups) {
    const from = needString(obj.from, 'from', at);
    const to = needString(obj.to, 'to', at);
    if (from !== '*' && !moldMap.has(from)) throw new InputError('E_INPUT', at, `setup references unknown mold "${from}"`);
    if (to !== '*' && !moldMap.has(to)) throw new InputError('E_INPUT', at, `setup references unknown mold "${to}"`);
    setupMap.set(`${from}->${to}`, needNumber(obj.minutes, 'minutes', at));
  }
  return { machines: machineMap, molds: moldMap, operators: operatorMap, orders: orderMap, setups: setupMap };
}

export function validateOrder(obj, at, moldMap, operatorMap) {
  const id = needString(obj.id, 'id', at);
  const mold = needString(obj.mold, 'mold', at);
  if (!moldMap.has(mold)) throw new InputError('E_INPUT', at, `order "${id}" references unknown mold "${mold}"`);
  const operator = needString(obj.operator, 'operator', at);
  if (!operatorMap.has(operator)) throw new InputError('E_INPUT', at, `order "${id}" references unknown operator "${operator}"`);
  return {
    id, mold, operator,
    qty: needNumber(obj.qty, 'qty', at, { min: 0, exclusiveMin: true }),
    due: needNumber(obj.due, 'due', at),
  };
}

export function setupMinutes(ds, fromMold, toMold) {
  if (fromMold == null || fromMold === toMold) return 0;
  return ds.setups.get(`${fromMold}->${toMold}`) ?? ds.setups.get(`*->${toMold}`)
      ?? ds.setups.get(`${fromMold}->*`) ?? ds.setups.get('*->*') ?? 0;
}

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function datasetSnapshot(ds) {
  return {
    machines: [...ds.machines.values()],
    molds: [...ds.molds.values()],
    operators: [...ds.operators.values()],
    orders: [...ds.orders.values()],
    setups: [...ds.setups.entries()].map(([k, minutes]) => {
      const [from, to] = k.split('->');
      return { from, to, minutes };
    }),
  };
}

export function datasetFromSnapshot(snap) {
  const wrap = (arr, at) => (arr || []).map((obj, i) => ({ obj, at: `${at}[${i}]` }));
  return buildDataset({
    machines: wrap(snap.machines, 'snapshot.machines'),
    molds: wrap(snap.molds, 'snapshot.molds'),
    operators: wrap(snap.operators, 'snapshot.operators'),
    orders: wrap(snap.orders, 'snapshot.orders'),
    setups: wrap(snap.setups, 'snapshot.setups'),
  });
}

export function datasetHash(ds) {
  return sha256(canonical(datasetSnapshot(ds)));
}
