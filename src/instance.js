// Input validation and normalization.
// Throws InputError (exit code 1 at the CLI) for any malformed instance.

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

export const PRIORITIES = Object.freeze(['critical', 'high', 'medium', 'low']);
const PRIORITY_SET = new Set(PRIORITIES);

/**
 * Validate a raw JSON value and return a normalized instance:
 * {
 *   machines: [{id}],
 *   shifts:   [{id, start, end, quotas: {family: slots}}],  // sorted, non-overlapping
 *   orders:   [{id, release, duration, deadline, family, priority,
 *               critical, machines: [machineIndex...]}],
 *   families: [...sorted unique family names...],
 *   horizon:  end of the last shift (all production must happen before it)
 * }
 */
export function validateInstance(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InputError('instance must be a JSON object');
  }
  const { machines: machinesRaw, shifts: shiftsRaw, orders: ordersRaw } = raw;
  if (!Array.isArray(machinesRaw) || machinesRaw.length === 0) {
    throw new InputError('"machines" must be a non-empty array');
  }
  if (!Array.isArray(shiftsRaw)) throw new InputError('"shifts" must be an array');
  if (!Array.isArray(ordersRaw)) throw new InputError('"orders" must be an array');

  const machines = [];
  const machineIndex = new Map();
  machinesRaw.forEach((m, i) => {
    const id = typeof m === 'string' ? m : (m && typeof m === 'object' ? m.id : undefined);
    if (typeof id !== 'string' || id === '') {
      throw new InputError(`machines[${i}]: id must be a non-empty string`);
    }
    if (machineIndex.has(id)) throw new InputError(`duplicate machine id "${id}"`);
    machineIndex.set(id, machines.length);
    machines.push({ id });
  });

  const shifts = shiftsRaw.map((s, i) => {
    if (typeof s !== 'object' || s === null || Array.isArray(s)) {
      throw new InputError(`shifts[${i}] must be an object`);
    }
    const id = s.id ?? `S${i + 1}`;
    if (typeof id !== 'string' || id === '') {
      throw new InputError(`shifts[${i}].id must be a non-empty string`);
    }
    const { start, end } = s;
    if (!Number.isInteger(start) || start < 0) {
      throw new InputError(`shift ${id}: start must be a non-negative integer`);
    }
    if (!Number.isInteger(end) || end <= start) {
      throw new InputError(`shift ${id}: end must be an integer greater than start`);
    }
    const quotas = s.quotas ?? {};
    if (typeof quotas !== 'object' || quotas === null || Array.isArray(quotas)) {
      throw new InputError(`shift ${id}: quotas must be an object mapping family -> slots`);
    }
    const q = {};
    for (const [family, value] of Object.entries(quotas)) {
      if (family === '') throw new InputError(`shift ${id}: family name must not be empty`);
      if (!Number.isInteger(value) || value < 0) {
        throw new InputError(`shift ${id}: quota for family "${family}" must be a non-negative integer`);
      }
      q[family] = value;
    }
    return { id, start, end, quotas: q };
  });
  shifts.sort((a, b) => a.start - b.start);
  const shiftIds = new Set();
  for (let i = 0; i < shifts.length; i++) {
    if (shiftIds.has(shifts[i].id)) throw new InputError(`duplicate shift id "${shifts[i].id}"`);
    shiftIds.add(shifts[i].id);
    if (i > 0 && shifts[i].start < shifts[i - 1].end) {
      throw new InputError(`shifts "${shifts[i - 1].id}" and "${shifts[i].id}" overlap`);
    }
  }

  const orderIds = new Set();
  const orders = ordersRaw.map((o, i) => {
    if (typeof o !== 'object' || o === null || Array.isArray(o)) {
      throw new InputError(`orders[${i}] must be an object`);
    }
    const id = o.id;
    if (typeof id !== 'string' || id === '') {
      throw new InputError(`orders[${i}].id must be a non-empty string`);
    }
    if (orderIds.has(id)) throw new InputError(`duplicate order id "${id}"`);
    orderIds.add(id);
    for (const field of ['release', 'duration', 'deadline']) {
      if (!Number.isInteger(o[field]) || o[field] < 0) {
        throw new InputError(`order ${id}: "${field}" must be a non-negative integer`);
      }
    }
    if (o.duration < 1) throw new InputError(`order ${id}: duration must be at least 1`);
    if (typeof o.family !== 'string' || o.family === '') {
      throw new InputError(`order ${id}: family must be a non-empty string`);
    }
    const priority = o.priority ?? 'low';
    if (!PRIORITY_SET.has(priority)) {
      throw new InputError(`order ${id}: priority must be one of ${PRIORITIES.join('|')}`);
    }
    if (!Array.isArray(o.machines)) {
      throw new InputError(`order ${id}: machines must be an array of machine ids`);
    }
    const compatible = [...new Set(o.machines.map((mid) => {
      if (typeof mid !== 'string' || !machineIndex.has(mid)) {
        throw new InputError(`order ${id}: unknown machine "${mid}"`);
      }
      return machineIndex.get(mid);
    }))];
    return {
      id,
      release: o.release,
      duration: o.duration,
      deadline: o.deadline,
      family: o.family,
      priority,
      critical: priority === 'critical',
      machines: compatible,
    };
  });

  const families = [...new Set(orders.map((o) => o.family))].sort();
  const horizon = shifts.length > 0 ? shifts[shifts.length - 1].end : 0;
  return { machines, shifts, orders, families, horizon };
}
