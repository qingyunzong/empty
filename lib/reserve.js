'use strict';

const { solve } = require('./solver');

class InputError extends Error {}

const DEFAULT_BACKTRACK_BUDGET = 10000;

function toCents(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InputError(`${field} must be a finite number`);
  }
  if (value < 0) {
    throw new InputError(`${field} must not be negative (got ${value})`);
  }
  return Math.round(value * 100);
}

function requireId(value, field, seen) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InputError(`${field} must be a non-empty string`);
  }
  if (seen.has(value)) {
    throw new InputError(`duplicate id: ${value}`);
  }
  seen.add(value);
  return value;
}

function requireCategory(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InputError(`${field} must be a non-empty string`);
  }
  return value;
}

function validate(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new InputError('input must be a JSON object');
  }
  const envelopeIds = new Set();
  const envelopes = (input.envelopes ?? []).map((raw, i) => {
    if (raw === null || typeof raw !== 'object') {
      throw new InputError(`envelopes[${i}] must be an object`);
    }
    return {
      id: requireId(raw.id, `envelopes[${i}].id`, envelopeIds),
      category: requireCategory(raw.category, `envelopes[${i}].category`),
      limitCents: toCents(raw.limit, `envelopes[${i}].limit`),
    };
  });
  const expenseIds = new Set();
  const expenses = (input.expenses ?? []).map((raw, i) => {
    if (raw === null || typeof raw !== 'object') {
      throw new InputError(`expenses[${i}] must be an object`);
    }
    const amountCents = toCents(raw.amount, `expenses[${i}].amount`);
    const paidCents = raw.paid === undefined ? 0 : toCents(raw.paid, `expenses[${i}].paid`);
    if (paidCents > amountCents) {
      throw new InputError(`expenses[${i}].paid exceeds expenses[${i}].amount`);
    }
    if (raw.group !== undefined && (typeof raw.group !== 'string' || raw.group.length === 0)) {
      throw new InputError(`expenses[${i}].group must be a non-empty string`);
    }
    return {
      id: requireId(raw.id, `expenses[${i}].id`, expenseIds),
      category: requireCategory(raw.category, `expenses[${i}].category`),
      amountCents,
      paidCents,
      group: raw.group,
    };
  });
  const cancellations = (input.cancellations ?? []).map((raw, i) => {
    const expenseId = typeof raw === 'string' ? raw : raw && raw.expenseId;
    if (typeof expenseId !== 'string' || expenseId.length === 0) {
      throw new InputError(`cancellations[${i}] must name an expense id`);
    }
    return expenseId;
  });
  let backtrackBudget = input.backtrackBudget ?? DEFAULT_BACKTRACK_BUDGET;
  if (!Number.isInteger(backtrackBudget) || backtrackBudget < 0) {
    throw new InputError('backtrackBudget must be a non-negative integer');
  }
  return { envelopes, expenses, cancellations, backtrackBudget };
}

function reserve(input) {
  const { envelopes, expenses, cancellations, backtrackBudget } = validate(input);

  const expenseById = new Map(expenses.map((expense) => [expense.id, expense]));
  const cancelledIds = new Set();
  const cancellationReports = [];
  for (const expenseId of cancellations) {
    const expense = expenseById.get(expenseId);
    if (!expense) {
      throw new InputError(`cancellation references unknown expense: ${expenseId}`);
    }
    if (cancelledIds.has(expenseId)) {
      throw new InputError(`duplicate cancellation for expense: ${expenseId}`);
    }
    cancelledIds.add(expenseId);
    cancellationReports.push({
      expenseId,
      released: (expense.amountCents - expense.paidCents) / 100,
      redFlushPending: expense.paidCents / 100,
    });
  }

  const active = expenses.filter((expense) => !cancelledIds.has(expense.id));
  const solved = solve(envelopes, active, backtrackBudget);

  const usedById = new Map(envelopes.map((env) => [env.id, 0]));
  for (const assignment of solved.assignments) {
    usedById.set(
      assignment.envelopeId,
      usedById.get(assignment.envelopeId) + Math.round(assignment.reserved * 100),
    );
  }

  return {
    status: solved.status,
    assignments: solved.assignments,
    envelopes: envelopes.map((env) => ({
      id: env.id,
      category: env.category,
      limit: env.limitCents / 100,
      used: usedById.get(env.id) / 100,
      remaining: (env.limitCents - usedById.get(env.id)) / 100,
    })),
    cancellations: cancellationReports,
    totals: {
      released: cancellationReports.reduce((sum, c) => sum + c.released, 0),
      redFlushPending: cancellationReports.reduce((sum, c) => sum + c.redFlushPending, 0),
      reserved: solved.assignments.reduce((sum, a) => sum + a.reserved, 0),
    },
    conflicts: solved.conflicts,
    stats: solved.stats,
  };
}

module.exports = { reserve, InputError };
