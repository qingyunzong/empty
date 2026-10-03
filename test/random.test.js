import test from 'node:test';
import assert from 'node:assert/strict';
import { Rat } from '../src/rational.js';
import { normalizeConstraint, isFeasible, findIIS, verifyIIS } from '../src/lp.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Independent exact oracle: Fourier-Motzkin elimination over rationals.
function fmFeasible(intRows, n) {
  let current = intRows.map((r) => ({
    a: r.a.map((v) => new Rat(v)),
    b: new Rat(r.b),
  }));
  for (let k = n - 1; k >= 0; k--) {
    const pos = [];
    const neg = [];
    const next = [];
    for (const r of current) {
      const s = r.a[k].sign();
      if (s > 0) pos.push(r);
      else if (s < 0) neg.push(r);
      else next.push(r);
    }
    for (const p of pos) {
      for (const q of neg) {
        const cp = q.a[k].neg(); // > 0
        const cq = p.a[k]; // > 0
        next.push({
          a: p.a.map((v, j) => v.mul(cp).add(q.a[j].mul(cq))),
          b: p.b.mul(cp).add(q.b.mul(cq)),
        });
      }
    }
    current = next;
  }
  return current.every((r) => r.b.sign() >= 0);
}

// Grid enumeration oracle: soundness witness for SAT only.
function gridFeasible(intRows, n) {
  const grid = [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2].map((v) => Rat.from(v));
  const point = new Array(n);
  const ok = () =>
    intRows.every((row) => {
      let lhs = new Rat(0n);
      for (let j = 0; j < n; j++) lhs = lhs.add(new Rat(row.a[j]).mul(point[j]));
      return lhs.cmp(new Rat(row.b)) <= 0;
    });
  const visit = (dim) => {
    if (dim === n) return ok();
    for (const v of grid) {
      point[dim] = v;
      if (visit(dim + 1)) return true;
    }
    return false;
  };
  return visit(0);
}

test('acceptance 4: random systems (m <= 5) cross-checked against FM oracle, grid, IIS certificates', () => {
  const rand = mulberry32(20261003);
  let sat = 0;
  let unsat = 0;
  let gridHits = 0;
  let certs = 0;
  for (const n of [1, 2, 3]) {
    for (let t = 0; t < 300; t++) {
      const m = 1 + Math.floor(rand() * 5);
      const rows = [];
      for (let i = 0; i < m; i++) {
        const coefs = Array.from({ length: n }, () => {
          const num = Math.floor(rand() * 7) - 3;
          const den = rand() < 0.25 ? 2 : 1;
          return [num, den];
        });
        const op = ['<=', '>=', '=='][Math.floor(rand() * 3)];
        const c = {
          coefs,
          op,
          rhsNum: Math.floor(rand() * 13) - 6,
          rhsDen: 1 + Math.floor(rand() * 3),
        };
        rows.push(...normalizeConstraint(c, { id: `n${n}t${t}#c${i}` }, n));
      }
      const got = isFeasible(rows, n);
      assert.equal(got, fmFeasible(rows, n), `Fourier-Motzkin mismatch at n=${n} case=${t}`);
      if (gridFeasible(rows, n)) {
        gridHits += 1;
        assert.equal(got, true, `grid witness found but solver said UNSAT at n=${n} case=${t}`);
      }
      if (got) {
        sat += 1;
      } else {
        unsat += 1;
        const iis = findIIS(rows, n);
        const v = verifyIIS(iis, n);
        assert.equal(v.valid, true, `invalid IIS at n=${n} case=${t}: ${v.reason}`);
        certs += 1;
      }
    }
  }
  console.log(
    `    random cross-check: ${sat} SAT, ${unsat} UNSAT, ` +
      `${certs} IIS certificates verified, ${gridHits} grid witnesses confirmed`,
  );
});
