'use strict';

const { TIERS } = require('./money');

class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkAmount(value, field, ctx) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InputError(`${ctx}: ${field} must be a finite number`);
  }
  if (value < 0) {
    throw new InputError(`${ctx}: ${field} must not be negative (got ${value})`);
  }
}

function validate(input) {
  if (!isPlainObject(input)) {
    throw new InputError('input must be a JSON object');
  }
  const packages = input.packages;
  const reimbursements = input.reimbursements;
  const cancellations = input.cancellations === undefined ? [] : input.cancellations;

  if (!Array.isArray(packages) || packages.length === 0) {
    throw new InputError('packages must be a non-empty array');
  }
  if (!Array.isArray(reimbursements)) {
    throw new InputError('reimbursements must be an array');
  }
  if (!Array.isArray(cancellations)) {
    throw new InputError('cancellations must be an array');
  }

  const pkgIds = new Set();
  for (const p of packages) {
    if (!isPlainObject(p) || typeof p.id !== 'string' || p.id === '') {
      throw new InputError('each package needs a non-empty string id');
    }
    if (pkgIds.has(p.id)) throw new InputError(`duplicate package id: ${p.id}`);
    pkgIds.add(p.id);
    if (!isPlainObject(p.limits) || Object.keys(p.limits).length === 0) {
      throw new InputError(`package ${p.id}: limits must be a non-empty object`);
    }
    for (const [cat, limit] of Object.entries(p.limits)) {
      checkAmount(limit, `limit for category "${cat}"`, `package ${p.id}`);
    }
  }

  const docIds = new Set();
  for (const r of reimbursements) {
    if (!isPlainObject(r) || typeof r.id !== 'string' || r.id === '') {
      throw new InputError('each reimbursement needs a non-empty string id');
    }
    if (docIds.has(r.id)) throw new InputError(`duplicate reimbursement id: ${r.id}`);
    docIds.add(r.id);
    if (typeof r.category !== 'string' || r.category === '') {
      throw new InputError(`reimbursement ${r.id}: category must be a non-empty string`);
    }
    checkAmount(r.amount, 'amount', `reimbursement ${r.id}`);
    if (r.paid !== undefined) {
      checkAmount(r.paid, 'paid', `reimbursement ${r.id}`);
      if (r.paid > r.amount) {
        throw new InputError(`reimbursement ${r.id}: paid (${r.paid}) exceeds amount (${r.amount})`);
      }
    }
    if (r.group !== undefined && (typeof r.group !== 'string' || r.group === '')) {
      throw new InputError(`reimbursement ${r.id}: group must be a non-empty string`);
    }
    if (r.tiers !== undefined) {
      if (!Array.isArray(r.tiers) || r.tiers.length === 0) {
        throw new InputError(`reimbursement ${r.id}: tiers must be a non-empty array`);
      }
      for (const t of r.tiers) {
        if (!TIERS.includes(t)) {
          throw new InputError(`reimbursement ${r.id}: unknown tier "${t}" (allowed: ${TIERS.join(', ')})`);
        }
      }
    }
  }

  const cancelIds = new Set();
  const cancelTargets = new Set();
  for (const c of cancellations) {
    if (!isPlainObject(c) || typeof c.id !== 'string' || c.id === '') {
      throw new InputError('each cancellation needs a non-empty string id');
    }
    if (cancelIds.has(c.id)) throw new InputError(`duplicate cancellation id: ${c.id}`);
    cancelIds.add(c.id);
    if (typeof c.target !== 'string' || !docIds.has(c.target)) {
      throw new InputError(`cancellation ${c.id}: unknown reimbursement "${c.target}"`);
    }
    if (cancelTargets.has(c.target)) {
      throw new InputError(`cancellation ${c.id}: reimbursement "${c.target}" is already cancelled`);
    }
    cancelTargets.add(c.target);
    if (c.package !== undefined && !pkgIds.has(c.package)) {
      throw new InputError(`cancellation ${c.id}: unknown package "${c.package}"`);
    }
  }

  if (input.backtrackBudget !== undefined) {
    const b = input.backtrackBudget;
    if (typeof b !== 'number' || !Number.isInteger(b) || b < 0) {
      throw new InputError('backtrackBudget must be a non-negative integer');
    }
  }
}

module.exports = { validate, InputError };
