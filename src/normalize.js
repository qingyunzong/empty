import { CODES, PlanError } from './errors.js';
import { MINUTE_MS, parseInstant } from './calendar.js';

export function normalizeMachines(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new PlanError(CODES.VALIDATION, 'machines must be a non-empty array of ids');
  }
  const ids = raw.map((m, i) => {
    const id = typeof m === 'string' ? m : m?.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new PlanError(CODES.VALIDATION, `machines[${i}] must have a non-empty string id`);
    }
    return id;
  });
  if (new Set(ids).size !== ids.length) {
    throw new PlanError(CODES.VALIDATION, 'machines contain duplicate ids');
  }
  return ids;
}

function optionalInstant(value, field) {
  if (value === undefined || value === null) return undefined;
  return parseInstant(value, field);
}

export function normalizeOrder(raw, machineIds) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PlanError(CODES.VALIDATION, 'order must be an object');
  }
  const id = raw.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new PlanError(CODES.VALIDATION, 'order.id must be a non-empty string');
  }
  const quantity = raw.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new PlanError(CODES.VALIDATION, `order ${id}: quantity must be an integer >= 1`);
  }
  if (!Array.isArray(raw.operations) || raw.operations.length === 0) {
    throw new PlanError(CODES.VALIDATION, `order ${id}: operations must be a non-empty array`);
  }
  const opsById = new Map();
  for (const [index, op] of raw.operations.entries()) {
    const field = `order ${id} operations[${index}]`;
    if (op === null || typeof op !== 'object') {
      throw new PlanError(CODES.VALIDATION, `${field} must be an object`);
    }
    if (typeof op.id !== 'string' || op.id.length === 0) {
      throw new PlanError(CODES.VALIDATION, `${field}.id must be a non-empty string`);
    }
    if (opsById.has(op.id)) {
      throw new PlanError(CODES.VALIDATION, `order ${id}: duplicate operation id ${op.id}`);
    }
    if (!machineIds.includes(op.machine)) {
      throw new PlanError(CODES.VALIDATION, `order ${id} op ${op.id}: unknown machine ${JSON.stringify(op.machine)}`);
    }
    if (!(typeof op.cycleTime === 'number' && op.cycleTime > 0)) {
      throw new PlanError(CODES.VALIDATION, `order ${id} op ${op.id}: cycleTime must be a positive number of minutes`);
    }
    const alternatives = op.alternatives ?? [];
    if (!Array.isArray(alternatives)) {
      throw new PlanError(CODES.VALIDATION, `order ${id} op ${op.id}: alternatives must be an array of machine ids`);
    }
    for (const alt of alternatives) {
      if (!machineIds.includes(alt)) {
        throw new PlanError(CODES.VALIDATION, `order ${id} op ${op.id}: unknown alternative machine ${JSON.stringify(alt)}`);
      }
    }
    const duration = Math.round(op.cycleTime * quantity * MINUTE_MS);
    if (duration <= 0) {
      throw new PlanError(CODES.VALIDATION, `order ${id} op ${op.id}: total duration must be positive`);
    }
    opsById.set(op.id, {
      opId: op.id,
      machine: op.machine,
      alternatives: [...new Set(alternatives)].filter((a) => a !== op.machine),
      duration,
    });
  }
  const route = raw.route ?? raw.operations.map((o) => o.id);
  if (!Array.isArray(route) || route.length === 0) {
    throw new PlanError(CODES.VALIDATION, `order ${id}: route must be a non-empty array of operation ids`);
  }
  const seen = new Set();
  for (const opId of route) {
    if (seen.has(opId)) {
      throw new PlanError(CODES.CYCLIC_ROUTE, `order ${id}: route contains a cycle at operation ${opId}`, {
        orderId: id,
        opId,
      });
    }
    seen.add(opId);
    if (!opsById.has(opId)) {
      throw new PlanError(CODES.VALIDATION, `order ${id}: route references unknown operation ${JSON.stringify(opId)}`);
    }
  }
  return {
    id,
    quantity,
    release: optionalInstant(raw.release, `order ${id}.release`),
    due: optionalInstant(raw.due, `order ${id}.due`),
    deadline: optionalInstant(raw.deadline, `order ${id}.deadline`),
    ops: route.map((opId) => opsById.get(opId)),
  };
}
