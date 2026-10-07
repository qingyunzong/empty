'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Rat } = require('../src/rational');
const {
  normalizeRows,
  feasiblePoint,
  findIIS,
  farkasCertificate,
  verifyCertificate,
} = require('../src/lp');

// Deterministic PRNG so failures reproduce.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Independent oracle: plain Fourier-Motzkin feasibility, implemented here
// (separately from the library) to cross-validate vertex enumeration.
function fmFeasible(constraints, dim) {
  let cur = normalizeRows(constraints).map((r) => ({ a: r.coefs, b: r.rhs }));
  for (let j = 0; j < dim; j++) {
    const pos = [], neg = [], zero = [];
    for (const row of cur) {
      const s = row.a[j].sign();
      if (s > 0) pos.push(row);
      else if (s < 0) neg.push(row);
      else zero.push(row);
    }
    const next = zero.slice();
    for (const p of pos) {
      for (const q of neg) {
        const cp = p.a[j], cq = q.a[j].neg();
        next.push({
          a: p.a.map((v, t) => v.mul(cq).add(q.a[t].mul(cp))),
          b: p.b.mul(cq).add(q.b.mul(cp)),
        });
      }
    }
    cur = next;
  }
  return cur.every((row) => row.b.sign() >= 0);
}

function randomSystem(rand) {
  const dim = 1 + Math.floor(rand() * 3); // 1..3
  const nCons = 1 + Math.floor(rand() * 5); // <= 5 constraints
  const ops = ['<=', '>=', '=='];
  const constraints = [];
  for (let i = 0; i < nCons; i++) {
    const coefs = Array.from({ length: dim }, () => new Rat(BigInt(Math.floor(rand() * 9) - 4)));
    const rhs = new Rat(BigInt(Math.floor(rand() * 19) - 9), BigInt(rand() < 0.3 ? 2 : 1));
    constraints.push({ id: `r${i}`, coefs, op: ops[Math.floor(rand() * 3)], rhs });
  }
  return { dim, constraints };
}

function satisfiesAll(constraints, x) {
  return constraints.every((c) => {
    let s = Rat.zero();
    for (let j = 0; j < x.length; j++) s = s.add(c.coefs[j].mul(x[j]));
    const cmp = s.cmp(c.rhs);
    return c.op === '<=' ? cmp <= 0 : c.op === '>=' ? cmp >= 0 : cmp === 0;
  });
}

test('acceptance 4: random systems (<=5 constraints, dim<=3) cross-checked', () => {
  const rand = mulberry32(20261008);
  const gridVals = [-2, -1, -0.5, 0, 0.5, 1, 2].map((v) => new Rat(BigInt(Math.round(v * 2)), 2n));
  let satCount = 0;
  let unsatCount = 0;
  for (let iter = 0; iter < 300; iter++) {
    const { dim, constraints } = randomSystem(rand);
    const res = feasiblePoint(constraints, dim);
    // 1. agrees with the independent FM oracle
    assert.equal(res.sat, fmFeasible(constraints, dim), `oracle mismatch at iter ${iter}`);
    // 2. grid cross-check: any feasible grid point forces SAT
    let gridHit = false;
    const tryGrid = (prefix) => {
      if (prefix.length === dim) {
        if (satisfiesAll(constraints, prefix)) gridHit = true;
        return;
      }
      for (const v of gridVals) tryGrid(prefix.concat([v]));
    };
    tryGrid([]);
    if (gridHit) assert.equal(res.sat, true, `grid witness but UNSAT at iter ${iter}`);
    if (res.sat) {
      satCount++;
      // 3. returned vertex satisfies every constraint exactly
      assert.ok(satisfiesAll(constraints, res.point), `bad witness at iter ${iter}`);
    } else {
      unsatCount++;
      // 4. IIS is infeasible, irreducible, and carries a valid certificate
      const iisIdx = findIIS(constraints, dim);
      const iis = iisIdx.map((i) => constraints[i]);
      assert.equal(fmFeasible(iis, dim), false, `IIS feasible at iter ${iter}`);
      for (const i of iisIdx) {
        const rest = constraints.filter((_, j) => iisIdx.includes(j) && j !== i);
        assert.equal(fmFeasible(rest, dim), true, `IIS not irreducible at iter ${iter}`);
      }
      const cert = farkasCertificate(iis, dim);
      assert.ok(cert, `no certificate at iter ${iter}`);
      assert.equal(verifyCertificate(iis, dim, cert), true, `bad certificate at iter ${iter}`);
    }
  }
  // sanity: the random suite actually exercised both outcomes
  assert.ok(satCount > 0 && unsatCount > 0, `sat=${satCount} unsat=${unsatCount}`);
  console.log(`random cross-check: ${satCount} SAT, ${unsatCount} UNSAT over 300 systems`);
});
