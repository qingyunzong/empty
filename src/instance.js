// Input parsing and validation. Any violation throws InstanceError,
// which the CLI maps to exit code 1 with a message on stderr.

export class InstanceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InstanceError';
  }
}

function fail(message) {
  throw new InstanceError(message);
}

export const PRIORITY_LEVELS = { low: 0, normal: 1, high: 2, critical: 3 };
const PRIORITY_NAMES = ['low', 'normal', 'high', 'critical'];

function parsePriority(value, where) {
  if (value === undefined) return { priority: 'normal', priorityLevel: 1 };
  if (typeof value === 'string' && value in PRIORITY_LEVELS) {
    return { priority: value, priorityLevel: PRIORITY_LEVELS[value] };
  }
  if (Number.isInteger(value) && value >= 0 && value <= 3) {
    return { priority: PRIORITY_NAMES[value], priorityLevel: value };
  }
  fail(`${where}: priority must be one of low|normal|high|critical or an integer 0..3`);
}

export function parseInstance(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('instance must be a JSON object');
  }

  const now = raw.now === undefined ? 0 : raw.now;
  if (!Number.isInteger(now) || now < 0) fail('now must be a non-negative integer');

  if (!Array.isArray(raw.machines) || raw.machines.length === 0) {
    fail('machines must be a non-empty array');
  }
  const machines = raw.machines.map((m, i) => {
    const id = typeof m === 'string' ? m : m && typeof m === 'object' ? m.id : undefined;
    if (typeof id !== 'string' || id.length === 0) {
      fail(`machines[${i}] must be a non-empty string id`);
    }
    return id;
  });
  if (new Set(machines).size !== machines.length) fail('machine ids must be unique');

  if (!Array.isArray(raw.shifts)) fail('shifts must be an array');
  const shifts = raw.shifts.map((s, i) => {
    if (s === null || typeof s !== 'object' || Array.isArray(s)) {
      fail(`shifts[${i}] must be an object`);
    }
    const id = s.id === undefined ? `S${i + 1}` : s.id;
    if (typeof id !== 'string' || id.length === 0) fail(`shifts[${i}].id must be a non-empty string`);
    const { start, end } = s;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
      fail(`shifts[${i}] must have integers 0 <= start < end`);
    }
    const quotas = s.quotas === undefined ? {} : s.quotas;
    if (quotas === null || typeof quotas !== 'object' || Array.isArray(quotas)) {
      fail(`shifts[${i}].quotas must be an object mapping family -> non-negative integer`);
    }
    const q = {};
    for (const [family, v] of Object.entries(quotas)) {
      if (!Number.isInteger(v) || v < 0) {
        fail(`shifts[${i}].quotas[${JSON.stringify(family)}] must be a non-negative integer`);
      }
      q[family] = v;
    }
    return { id, start, end, quotas: q };
  });
  if (new Set(shifts.map((s) => s.id)).size !== shifts.length) fail('shift ids must be unique');
  const byStart = [...shifts].sort((a, b) => a.start - b.start);
  for (let i = 1; i < byStart.length; i += 1) {
    if (byStart[i].start < byStart[i - 1].end) fail('shifts must not overlap');
  }

  if (!Array.isArray(raw.orders)) fail('orders must be an array');
  const orders = raw.orders.map((o, i) => {
    const where = `orders[${i}]`;
    if (o === null || typeof o !== 'object' || Array.isArray(o)) fail(`${where} must be an object`);
    if (typeof o.id !== 'string' && typeof o.id !== 'number') fail(`${where}.id must be a string or number`);
    const id = String(o.id);
    if (id.length === 0) fail(`${where}.id must be non-empty`);
    if (!Number.isInteger(o.release) || o.release < 0) fail(`${where}.release must be a non-negative integer`);
    if (!Number.isInteger(o.duration) || o.duration < 1) fail(`${where}.duration must be an integer >= 1`);
    if (!Number.isInteger(o.deadline) || o.deadline < 0) fail(`${where}.deadline must be a non-negative integer`);
    if (typeof o.family !== 'string' || o.family.length === 0) fail(`${where}.family must be a non-empty string`);
    const { priority, priorityLevel } = parsePriority(o.priority, where);
    if (!Array.isArray(o.machines) || o.machines.length === 0) {
      fail(`${where}.machines must be a non-empty array of machine ids`);
    }
    const compat = o.machines.map((mid) => {
      if (typeof mid !== 'string' || !machines.includes(mid)) {
        fail(`${where}.machines contains unknown machine id ${JSON.stringify(mid)}`);
      }
      return mid;
    });
    if (new Set(compat).size !== compat.length) fail(`${where}.machines must not contain duplicates`);
    return {
      id,
      release: o.release,
      duration: o.duration,
      deadline: o.deadline,
      family: o.family,
      priority,
      priorityLevel,
      machines: compat,
    };
  });
  const ids = orders.map((o) => o.id);
  if (new Set(ids).size !== ids.length) fail('order ids must be unique');
  // Dictionary order by order id drives the tie-break vector.
  orders.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return { now, machines, shifts, orders };
}
