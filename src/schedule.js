'use strict';

const { PlanError } = require('./errors');

const DAY_MS = 86400000;

// Accepts a non-negative integer day index or an ISO "YYYY-MM-DD" date.
function normalizeDue(due) {
  if (typeof due === 'number' && Number.isInteger(due) && due >= 0) return due;
  if (typeof due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(due)) {
    const ms = Date.parse(`${due}T00:00:00Z`);
    if (!Number.isNaN(ms)) return Math.floor(ms / DAY_MS);
  }
  throw new PlanError('E_USAGE', `invalid due date: ${JSON.stringify(due)}`);
}

function validateOrder(order) {
  if (order === null || typeof order !== 'object' || Array.isArray(order)) {
    throw new PlanError('E_USAGE', `order must be an object, got: ${JSON.stringify(order)}`);
  }
  const { id, quantity, due, machine } = order;
  if (typeof id !== 'string' || id.length === 0) {
    throw new PlanError('E_USAGE', `order id must be a non-empty string: ${JSON.stringify(order)}`);
  }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new PlanError('E_USAGE', `order ${id}: quantity must be a positive integer`);
  }
  if (typeof machine !== 'string' || machine.length === 0) {
    throw new PlanError('E_USAGE', `order ${id}: machine must be a non-empty string`);
  }
  return { id, quantity, due: normalizeDue(due), machine };
}

// Single production line: orders run one at a time in sequence; an order
// occupies its machine for ceil(quantity / dailyCapacity[machine]) whole days.
// A permutation is feasible when every order finishes on or before its due day.
// Among feasible permutations the one sorted by (due, id) is selected; by the
// earliest-due-date optimality argument it is feasible whenever any
// permutation is, and it is the lexicographically smallest (due, id) key
// sequence over all permutations.
function planSchedule(orders, capacity) {
  if (capacity === null || typeof capacity !== 'object' || Array.isArray(capacity)) {
    throw new PlanError('E_USAGE', 'capacity must be an object mapping machine -> units per day');
  }
  const items = orders.map((o) => ({ ...o, due: normalizeDue(o.due) }));
  for (const o of items) {
    const cap = capacity[o.machine];
    if (!Number.isFinite(cap) || cap <= 0) {
      throw new PlanError('E_CAPACITY', `no positive daily capacity for machine "${o.machine}" (order ${o.id})`, {
        machine: o.machine,
        order: o.id,
      });
    }
  }
  const sorted = [...items].sort((a, b) => a.due - b.due || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sequence = [];
  let day = 0;
  for (const o of sorted) {
    const duration = Math.ceil(o.quantity / capacity[o.machine]);
    const start = day + 1;
    const finish = day + duration;
    if (finish > o.due) {
      throw new PlanError(
        'E_CAPACITY',
        `infeasible: order ${o.id} finishes day ${finish}, past due day ${o.due}`,
        { order: o.id, finish, due: o.due },
      );
    }
    day = finish;
    sequence.push({ id: o.id, machine: o.machine, quantity: o.quantity, due: o.due, start, finish });
  }
  return { sequence, makespan: day };
}

module.exports = { planSchedule, validateOrder, normalizeDue };
