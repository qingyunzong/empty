'use strict';

// Base dimensions: L = length, M = mass, T = time.
// A dimension is an exponent vector [L, M, T]; multiplication/division
// combine vectors by adding/subtracting exponents.
const BASES = ['L', 'M', 'T'];

// Finite built-in dimension table (name -> vector).
const NAMED_DIMENSIONS = [
  ['1', [0, 0, 0]],
  ['m', [1, 0, 0]],
  ['s', [0, 0, 1]],
  ['kg', [0, 1, 0]],
  ['Hz', [0, 0, -1]],
  ['m/s', [1, 0, -1]],
  ['m/s^2', [1, 0, -2]],
  ['N', [1, 1, -2]],
  ['Pa', [-1, 1, -2]],
  ['J', [2, 1, -2]],
  ['W', [2, 1, -3]],
];

const NAME_TO_VEC = new Map(NAMED_DIMENSIONS.map(([n, v]) => [n, v]));
const VEC_TO_NAME = new Map(NAMED_DIMENSIONS.map(([n, v]) => [v.join(','), n]));

function keyOf(vec) {
  return vec.join(',');
}

function zero() {
  return [0, 0, 0];
}

function add(a, b) {
  return a.map((x, i) => x + b[i]);
}

function sub(a, b) {
  return a.map((x, i) => x - b[i]);
}

function scale(a, k) {
  return a.map((x) => x * k);
}

function equal(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function parseDimension(name) {
  const vec = NAME_TO_VEC.get(name);
  if (!vec) {
    const known = [...NAME_TO_VEC.keys()].join(', ');
    throw new Error(`unknown dimension "${name}" (known: ${known})`);
  }
  return [...vec];
}

function formatExponent(n) {
  return Number.isInteger(n) ? String(n) : String(n);
}

function formatDimension(vec) {
  const named = VEC_TO_NAME.get(keyOf(vec));
  if (named) return named;
  const parts = [];
  vec.forEach((e, i) => {
    if (e !== 0) parts.push(e === 1 ? BASES[i] : `${BASES[i]}^${formatExponent(e)}`);
  });
  return parts.length === 0 ? '1' : parts.join('*');
}

module.exports = {
  BASES,
  NAMED_DIMENSIONS,
  keyOf,
  zero,
  add,
  sub,
  scale,
  equal,
  parseDimension,
  formatDimension,
};
