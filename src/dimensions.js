import { FormulaError } from './errors.js';

export const BASE_DIMS = ['m', 's', 'kg'];

export function dim(exps = {}) {
  const v = { m: 0, s: 0, kg: 0 };
  for (const b of BASE_DIMS) {
    if (exps[b] !== undefined) v[b] = exps[b];
  }
  return v;
}

export const DIMENSIONLESS = dim();

export const NAMED_DIMENSIONS = {
  '1': DIMENSIONLESS,
  'm': dim({ m: 1 }),
  's': dim({ s: 1 }),
  'kg': dim({ kg: 1 }),
  'Hz': dim({ s: -1 }),
  'm/s': dim({ m: 1, s: -1 }),
  'm/s^2': dim({ m: 1, s: -2 }),
  'N': dim({ kg: 1, m: 1, s: -2 }),
  'J': dim({ kg: 1, m: 2, s: -2 }),
  'W': dim({ kg: 1, m: 2, s: -3 }),
  'Pa': dim({ kg: 1, m: -1, s: -2 }),
};

export function dimKey(d) {
  return BASE_DIMS.map((b) => d[b]).join(',');
}

const KEY_TO_NAME = new Map();
for (const [name, d] of Object.entries(NAMED_DIMENSIONS)) {
  if (!KEY_TO_NAME.has(dimKey(d))) KEY_TO_NAME.set(dimKey(d), name);
}

export function parseDimension(name) {
  const d = NAMED_DIMENSIONS[name];
  if (!d) {
    throw new FormulaError('UNKNOWN_DIMENSION', `unknown dimension "${name}"`, {
      dimension: name,
      known: Object.keys(NAMED_DIMENSIONS),
    });
  }
  return { ...d };
}

export function formatDim(d) {
  const named = KEY_TO_NAME.get(dimKey(d));
  if (named) return named;
  const parts = [];
  for (const b of BASE_DIMS) {
    if (d[b] !== 0) parts.push(d[b] === 1 ? b : `${b}^${d[b]}`);
  }
  return parts.length === 0 ? '1' : parts.join('*');
}

export function dimVector(d) {
  return BASE_DIMS.map((b) => d[b]);
}

export function equalDim(a, b) {
  return BASE_DIMS.every((k) => a[k] === b[k]);
}

export function mulDim(a, b) {
  return dim({ m: a.m + b.m, s: a.s + b.s, kg: a.kg + b.kg });
}

export function divDim(a, b) {
  return dim({ m: a.m - b.m, s: a.s - b.s, kg: a.kg - b.kg });
}

export function powDim(a, n) {
  return dim({ m: a.m * n, s: a.s * n, kg: a.kg * n });
}
