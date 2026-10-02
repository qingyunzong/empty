'use strict';
const { normalizePlan } = require('./canonical');

const FORBIDDEN = '|';

function assertName(kind, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${kind} must be a non-empty string`);
  }
  if (value.includes(FORBIDDEN)) {
    throw new Error(`${kind} must not contain '${FORBIDDEN}'`);
  }
}

function assertNonNegativeInteger(kind, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${kind} must be a non-negative integer`);
  }
}

function validateAllocation(a) {
  if (a === null || typeof a !== 'object' || Array.isArray(a)) {
    throw new Error('allocation must be an object');
  }
  assertName('machine', a.machine);
  assertName('material', a.material);
  assertNonNegativeInteger('day', a.day);
  assertNonNegativeInteger('amount', a.amount);
}

function validatePlan(plan) {
  const normalized = normalizePlan(plan);
  for (const a of normalized) validateAllocation(a);
  return normalized;
}

// Aggregate a plan's amounts per (material, day) -> Map "material|day" -> amount
function aggregatePlan(plan) {
  const map = new Map();
  for (const a of plan) {
    const key = `${a.material}|${a.day}`;
    map.set(key, (map.get(key) ?? 0) + a.amount);
  }
  return map;
}

module.exports = { assertName, assertNonNegativeInteger, validateAllocation, validatePlan, aggregatePlan };
