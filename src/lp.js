'use strict';

const { Rat, parseRat } = require('./rational');
const { solve } = require('./linsolve');

// A constraint: { id, coefs: [Rat] (length = dim), op: '<='|'>='|'==', rhs: Rat }.
// All half-planes are closed (boundary included).

// Normalize every constraint into one or two '<=' rows.
// Each row: { coefs: [Rat], rhs: Rat, id, sub } where sub identifies which
// normalized half of the original constraint this row is.
function normalizeRows(constraints) {
  const rows = [];
  for (const c of constraints) {
    if (c.op === '<=') {
      rows.push({ coefs: c.coefs, rhs: c.rhs, id: c.id, sub: 'le' });
    } else if (c.op === '>=') {
      rows.push({ coefs: c.coefs.map((x) => x.neg()), rhs: c.rhs.neg(), id: c.id, sub: 'ge' });
    } else if (c.op === '==') {
      rows.push({ coefs: c.coefs, rhs: c.rhs, id: c.id, sub: 'eq+' });
      rows.push({ coefs: c.coefs.map((x) => x.neg()), rhs: c.rhs.neg(), id: c.id, sub: 'eq-' });
    } else {
      throw new Error(`unknown op: ${c.op}`);
    }
  }
  return rows;
}

function dot(a, x) {
  let s = Rat.zero();
  for (let i = 0; i < a.length; i++) s = s.add(a[i].mul(x[i]));
  return s;
}

function* combinations(arr, k) {
  if (k === 0) { yield []; return; }
  if (k > arr.length) return;
  const idx = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    yield idx.map((i) => arr[i]);
    let i = k - 1;
    while (i >= 0 && idx[i] === arr.length - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

function popcount(m) {
  let c = 0;
  while (m) { c += m & 1; m >>= 1; }
  return c;
}

// Exact feasibility via generalized vertex enumeration.
//
// A nonempty polyhedron {x : Ax <= b} always contains a point that is the
// unique solution of a square nonsingular system built from a subset of the
// (normalized) tight rows and a subset of the columns, with the remaining
// variables fixed to 0 (take any point of a minimal face and read off a
// basic solution of its defining equality system). So enumerating all
// (column subset S, row subset R with |R| = |S|) pairs and solving exactly
// is a complete decision procedure. Candidates with |S| = dim are true
// vertices of the arrangement; they are tried first so a SAT witness is a
// genuine vertex whenever one exists.
function feasiblePoint(constraints, dim) {
  const rows = normalizeRows(constraints);
  const test = (x) => rows.every((r) => dot(r.coefs, x).cmp(r.rhs) <= 0);
  const masks = [];
  for (let m = 0; m < (1 << dim); m++) masks.push(m);
  masks.sort((a, b) => popcount(b) - popcount(a));
  for (const mask of masks) {
    const cols = [];
    for (let j = 0; j < dim; j++) if ((mask >> j) & 1) cols.push(j);
    const k = cols.length;
    for (const combo of combinations(rows, k)) {
      const A = combo.map((r) => cols.map((j) => r.coefs[j]));
      const b = combo.map((r) => r.rhs);
      const sol = solve(A, b);
      if (sol === null) continue;
      const x = Array.from({ length: dim }, () => Rat.zero());
      cols.forEach((j, i) => { x[j] = sol[i]; });
      if (test(x)) return { sat: true, point: x };
    }
  }
  return { sat: false };
}

// Deletion-based irreducible infeasible subset (IIS): returns indices into
// the constraints array such that the subset is infeasible but dropping any
// single member makes it feasible.
function findIIS(constraints, dim) {
  let idx = constraints.map((_, i) => i);
  for (let i = 0; i < idx.length;) {
    const trial = idx.filter((j) => j !== idx[i]);
    const sub = trial.map((j) => constraints[j]);
    if (!feasiblePoint(sub, dim).sat) {
      idx = trial;
    } else {
      i++;
    }
  }
  return idx;
}

// Farkas infeasibility certificate via Fourier-Motzkin elimination with
// multiplier tracking. Returns null if feasible; otherwise a list of
// { id, sub, lambda: Rat } with lambda >= 0 over the normalized rows of
// `constraints`, such that sum(lambda_i * a_i) = 0 and
// sum(lambda_i * b_i) < 0.
function farkasCertificate(constraints, dim) {
  const rows = normalizeRows(constraints);
  let cur = rows.map((r, i) => ({
    a: r.coefs.slice(),
    b: r.rhs,
    lam: rows.map((_, j) => (j === i ? Rat.one() : Rat.zero())),
  }));
  for (let j = 0; j < dim; j++) {
    const pos = [];
    const neg = [];
    const zero = [];
    for (const r of cur) {
      const s = r.a[j].sign();
      if (s > 0) pos.push(r);
      else if (s < 0) neg.push(r);
      else zero.push(r);
    }
    const next = zero.slice();
    for (const p of pos) {
      for (const q of neg) {
        const cp = p.a[j]; // > 0
        const cq = q.a[j].neg(); // > 0
        next.push({
          a: p.a.map((v, t) => v.mul(cq).add(q.a[t].mul(cp))),
          b: p.b.mul(cq).add(q.b.mul(cp)),
          lam: p.lam.map((v, t) => v.mul(cq).add(q.lam[t].mul(cp))),
        });
      }
    }
    cur = next;
  }
  for (const r of cur) {
    if (r.b.sign() < 0) {
      const out = [];
      for (let i = 0; i < rows.length; i++) {
        if (!r.lam[i].isZero()) out.push({ id: rows[i].id, sub: rows[i].sub, lambda: r.lam[i] });
      }
      return out;
    }
  }
  return null;
}

// Independently verify a Farkas certificate against a constraint set.
// cert: [{ id, sub, lambda }] with lambda a Rat or anything parseRat accepts.
function verifyCertificate(constraints, dim, cert) {
  const rows = normalizeRows(constraints);
  const byKey = new Map(rows.map((r) => [`${r.id}|${r.sub}`, r]));
  const accA = Array.from({ length: dim }, () => Rat.zero());
  let accB = Rat.zero();
  for (const e of cert) {
    const row = byKey.get(`${e.id}|${e.sub}`);
    if (!row) return false;
    const lam = parseRat(e.lambda);
    if (lam.sign() < 0) return false;
    for (let j = 0; j < dim; j++) accA[j] = accA[j].add(lam.mul(row.coefs[j]));
    accB = accB.add(lam.mul(row.rhs));
  }
  return accA.every((v) => v.isZero()) && accB.sign() < 0;
}

module.exports = {
  normalizeRows,
  feasiblePoint,
  findIIS,
  farkasCertificate,
  verifyCertificate,
};
