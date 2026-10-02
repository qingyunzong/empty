'use strict';

const LESS = -1;
const EQUAL = 0;
const GREATER = 1;
const CONCURRENT = 2;

function normalizeClock(clock) {
  if (clock === null || typeof clock !== 'object' || Array.isArray(clock)) {
    throw new TypeError('vector clock must be an object mapping node ids to non-negative integers');
  }
  const out = {};
  for (const key of Object.keys(clock).sort()) {
    const value = clock[key];
    if (!Number.isInteger(value) || value < 0) {
      throw new TypeError(`invalid vector clock entry for "${key}": ${value}`);
    }
    if (value !== 0) out[key] = value;
  }
  return out;
}

function allKeys(a, b) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])];
}

// compare(a, b) -> LESS (a happens-before b), EQUAL, GREATER, CONCURRENT
function compare(a, b) {
  let less = false;
  let greater = false;
  for (const key of allKeys(a, b)) {
    const x = a[key] || 0;
    const y = b[key] || 0;
    if (x < y) less = true;
    else if (x > y) greater = true;
  }
  if (less && greater) return CONCURRENT;
  if (less) return LESS;
  if (greater) return GREATER;
  return EQUAL;
}

function happensBefore(a, b) {
  return compare(a, b) === LESS;
}

function areConcurrent(a, b) {
  return compare(a, b) === CONCURRENT;
}

function mergeClocks(a, b) {
  const out = {};
  for (const key of allKeys(a, b)) {
    out[key] = Math.max(a[key] || 0, b[key] || 0);
  }
  return out;
}

// isRegression(parent, child): true when the child clock dropped below the
// parent clock in any component (causality violation).
function isRegression(parent, child) {
  for (const key of Object.keys(parent)) {
    if ((child[key] || 0) < parent[key]) return true;
  }
  return false;
}

module.exports = {
  LESS,
  EQUAL,
  GREATER,
  CONCURRENT,
  normalizeClock,
  compare,
  happensBefore,
  areConcurrent,
  mergeClocks,
  isRegression,
};
