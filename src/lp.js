// Exact rational linear programming in dimension n <= 3.
//
// Every constraint is normalized to closed half-planes a*x <= b with integer
// coefficients (boundaries include equality: <=, >= and == are all non-strict).
// Feasibility is decided by exact vertex enumeration: the region is intersected
// with a bounding box whose side length exceeds any Cramer bound of a basic
// solution, so a nonempty region always has at least one vertex inside the box.

import { Rat, lcm } from './rational.js';
import { solve } from './matrix.js';

// constraint: { coefs: [rational...], op: '<='|'>='|'==', rhsNum, rhsDen }
// ref: metadata attached to every derived row (id, source, ...).
// Returns rows { a: BigInt[], b: BigInt, ref } in <= form.
export function normalizeConstraint(constraint, ref, dim) {
  if (!constraint || !Array.isArray(constraint.coefs) || constraint.coefs.length !== dim) {
    const err = new Error(`constraint ${ref.id}: expected ${dim} coefficients`);
    err.code = 'E_DIM';
    throw err;
  }
  let coefs;
  let rhs;
  try {
    coefs = constraint.coefs.map((v) => Rat.from(v));
    rhs = new Rat(BigInt(constraint.rhsNum ?? 0), BigInt(constraint.rhsDen ?? 1));
  } catch (e) {
    const err = new Error(`constraint ${ref.id}: malformed rational (${e.message})`);
    err.code = 'E_INPUT';
    throw err;
  }
  const op = constraint.op;
  if (op !== '<=' && op !== '>=' && op !== '==') {
    const err = new Error(`constraint ${ref.id}: unsupported op ${JSON.stringify(op)}`);
    err.code = 'E_INPUT';
    throw err;
  }
  let scale = 1n;
  for (const r of [...coefs, rhs]) scale = lcm(scale, r.den);
  const ai = coefs.map((r) => r.num * (scale / r.den));
  const bi = rhs.num * (scale / rhs.den);
  const rows = [];
  if (op === '<=' || op === '==') rows.push({ a: ai.slice(), b: bi, ref, part: '<=' });
  if (op === '>=' || op === '==') rows.push({ a: ai.map((v) => -v), b: -bi, ref, part: '>=' });
  return rows;
}

// Rebuilds the exact rows a certificate entry refers to. Entries carry a
// `part` selector so a single half-plane of an '==' constraint can be cited.
export function rowsForCertificateEntry(entry, dim) {
  const op = entry.part ?? entry.op;
  return normalizeConstraint(
    { coefs: entry.coefs, op, rhsNum: entry.rhsNum, rhsDen: entry.rhsDen },
    entry,
    dim,
  );
}

function isZeroRow(row) {
  return row.a.every((v) => v === 0n);
}

export function* combinations(m, k) {
  if (k > m || k < 0) return;
  if (k === 0) {
    yield [];
    return;
  }
  const idx = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    yield idx.slice();
    let i = k - 1;
    while (i >= 0 && idx[i] === m - k + i) i -= 1;
    if (i < 0) return;
    idx[i] += 1;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

function dotLeq(row, x) {
  let lhs = new Rat(0n);
  for (let j = 0; j < x.length; j++) {
    if (row.a[j] !== 0n) lhs = lhs.add(new Rat(row.a[j]).mul(x[j]));
  }
  return lhs.cmp(new Rat(row.b)) <= 0;
}

// All intersection points of n independent constraint boundaries that satisfy
// every row. Coordinates are exact reduced Rats.
export function enumerateVertices(rows, n) {
  const vertices = [];
  const seen = new Set();
  for (const combo of combinations(rows.length, n)) {
    const matrix = combo.map((i) => rows[i].a);
    const rhs = combo.map((i) => rows[i].b);
    const x = solve(matrix, rhs);
    if (x === null) continue;
    if (!rows.every((row) => dotLeq(row, x))) continue;
    const key = x.map((r) => r.toString()).join(',');
    if (!seen.has(key)) {
      seen.add(key);
      vertices.push(x);
    }
  }
  return vertices;
}

// Upper bound on the absolute value of any coordinate of any basic solution:
// |x_i| = |det_i| / |det| <= n! * M^n where M is the largest integer entry.
export function boundFor(rows, n) {
  let maxEntry = 0n;
  for (const row of rows) {
    for (const v of row.a) {
      const av = v < 0n ? -v : v;
      if (av > maxEntry) maxEntry = av;
    }
    const ab = row.b < 0n ? -row.b : row.b;
    if (ab > maxEntry) maxEntry = ab;
  }
  let fact = 1n;
  for (let i = 2n; i <= BigInt(n); i++) fact *= i;
  return fact * maxEntry ** BigInt(n) + 1n;
}

export function boxRows(n, bound) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const up = new Array(n).fill(0n);
    up[i] = 1n;
    rows.push({ a: up, b: bound, ref: { id: `#box x${i} <= B`, source: 'box' } });
    const lo = new Array(n).fill(0n);
    lo[i] = -1n;
    rows.push({ a: lo, b: bound, ref: { id: `#box x${i} >= -B`, source: 'box' } });
  }
  return rows;
}

export function isFeasible(rows, n) {
  const real = [];
  for (const row of rows) {
    if (isZeroRow(row)) {
      if (row.b < 0n) return false; // 0 <= negative constant
    } else {
      real.push(row);
    }
  }
  const bound = boundFor(real, n);
  return enumerateVertices(real.concat(boxRows(n, bound)), n).length > 0;
}

// Deletion filter: produces an inclusion-minimal infeasible subsystem (IIS).
export function findIIS(rows, n) {
  let current = rows.slice();
  for (let i = 0; i < current.length; i++) {
    const trial = current.slice(0, i).concat(current.slice(i + 1));
    if (!isFeasible(trial, n)) {
      current = trial;
      i -= 1;
    }
  }
  return current;
}

// Exact certificate check: the rows must be infeasible, and dropping any
// single row must make the remainder feasible.
export function verifyIIS(rows, n) {
  if (isFeasible(rows, n)) return { valid: false, reason: 'subsystem is feasible' };
  for (let i = 0; i < rows.length; i++) {
    const rest = rows.slice(0, i).concat(rows.slice(i + 1));
    if (!isFeasible(rest, n)) {
      return { valid: false, reason: `not minimal: still infeasible without ${rows[i].ref?.id ?? i}` };
    }
  }
  return { valid: true };
}
