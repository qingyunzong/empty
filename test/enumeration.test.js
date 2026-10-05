import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from '../src/scheduler.js';

// Brute-force enumeration of every feasible borrow combination.
// Feasibility: per-lender caps, per-borrower demands, total <= root slack.
// Objective: maximize total borrowed slots; ties broken by the lexicographically
// largest flat vector [x_b..., y_(b,l)...] with borrowers/lenders in id order
// (i.e. earlier borrower served first, earliest lender used first).
function enumerateBest(lenderCaps, demands, rootSlack) {
  const lenderIds = Object.keys(lenderCaps).sort();
  const borrowerIds = Object.keys(demands).sort();
  let best = null;
  const xs = borrowerIds.map(() => 0);

  const lexGreater = (a, b) => {
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return a[i] > b[i];
    }
    return false;
  };

  function consider() {
    const total = xs.reduce((s, x) => s + x, 0);
    if (total > rootSlack) return;
    const ys = borrowerIds.map(() => Object.fromEntries(lenderIds.map((l) => [l, 0])));
    const caps = lenderIds.map((l) => lenderCaps[l]);
    function assign(bi) {
      if (bi === borrowerIds.length) {
        const flat = [total, ...xs, ...borrowerIds.flatMap((_, i) => lenderIds.map((l) => ys[i][l]))];
        if (!best || lexGreater(flat, best.flat)) {
          best = { total, xs: [...xs], ys: ys.map((y) => ({ ...y })), flat };
        }
        return;
      }
      const x = xs[bi];
      (function distribute(li, rem) {
        if (li === lenderIds.length) {
          if (rem === 0) assign(bi + 1);
          return;
        }
        for (let a = 0; a <= Math.min(rem, caps[li]); a += 1) {
          ys[bi][lenderIds[li]] = a;
          caps[li] -= a;
          distribute(li + 1, rem - a);
          caps[li] += a;
          ys[bi][lenderIds[li]] = 0;
        }
      })(0, x);
    }
    assign(0);
  }

  (function enumX(bi) {
    if (bi === borrowerIds.length) {
      consider();
      return;
    }
    for (let x = 0; x <= demands[borrowerIds[bi]]; x += 1) {
      xs[bi] = x;
      enumX(bi + 1);
    }
    xs[bi] = 0;
  })(0);

  return best;
}

const pruneZeros = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== 0));

function actualAllocation(report) {
  const xs = {};
  const ys = {};
  for (const r of report.borrowChain) {
    xs[r.borrower] = (xs[r.borrower] ?? 0) + 1;
    ys[r.borrower] ??= {};
    ys[r.borrower][r.lender] = (ys[r.borrower][r.lender] ?? 0) + 1;
  }
  return { xs, ys };
}

function expectedAllocation(best, borrowerIds) {
  const xs = {};
  const ys = {};
  best.xs.forEach((x, i) => {
    if (x > 0) {
      xs[borrowerIds[i]] = x;
      ys[borrowerIds[i]] = pruneZeros(best.ys[i]);
    }
  });
  return { xs, ys };
}

test('scheduler matches exhaustive enumeration: max utilization + lexicographic tie-break', () => {
  // root cap 4; lenders A(2), B(2); borrowers C, D with 3 orders each.
  const report = simulate({
    tenants: [
      { id: 'R', parent: null, guarantee: 4 },
      { id: 'A', parent: 'R', guarantee: 2 },
      { id: 'B', parent: 'R', guarantee: 2 },
      { id: 'C', parent: 'R', guarantee: 0 },
      { id: 'D', parent: 'R', guarantee: 0 },
    ],
    orders: [
      { id: 'c1', tenant: 'C', duration: 1 },
      { id: 'c2', tenant: 'C', duration: 1 },
      { id: 'c3', tenant: 'C', duration: 1 },
      { id: 'd1', tenant: 'D', duration: 1 },
      { id: 'd2', tenant: 'D', duration: 1 },
      { id: 'd3', tenant: 'D', duration: 1 },
    ],
    horizon: 1,
  });

  // lender caps at tick 0: A=2, B=2, R=4 (root slack binds total to 4)
  const best = enumerateBest({ A: 2, B: 2, R: 4 }, { C: 3, D: 3 }, 4);
  assert.equal(best.total, 4, 'max utilization is the full root cap');

  const actual = actualAllocation(report);
  const expected = expectedAllocation(best, ['C', 'D']);
  assert.equal(report.borrowChain.length, best.total, 'scheduler reaches max utilization');
  assert.deepEqual(actual.xs, expected.xs);
  assert.deepEqual(actual.ys, expected.ys);
  // concrete expectation: C takes 2 from A + 1 from B, D takes 1 from B
  assert.deepEqual(actual.xs, { C: 3, D: 1 });
  assert.deepEqual(actual.ys, { C: { A: 2, B: 1 }, D: { B: 1 } });
});

test('lexicographic tie-break prefers the earlier borrower', () => {
  // root cap 3; lenders A(2), B(1); borrowers C, D with 2 orders each.
  // Max utilization = 3 with two optimal splits (C:2,D:1) or (C:1,D:2);
  // the earlier borrower C must win.
  const report = simulate({
    tenants: [
      { id: 'R', parent: null, guarantee: 3 },
      { id: 'A', parent: 'R', guarantee: 2 },
      { id: 'B', parent: 'R', guarantee: 1 },
      { id: 'C', parent: 'R', guarantee: 0 },
      { id: 'D', parent: 'R', guarantee: 0 },
    ],
    orders: [
      { id: 'c1', tenant: 'C', duration: 1 },
      { id: 'c2', tenant: 'C', duration: 1 },
      { id: 'd1', tenant: 'D', duration: 1 },
      { id: 'd2', tenant: 'D', duration: 1 },
    ],
    horizon: 1,
  });

  const best = enumerateBest({ A: 2, B: 1, R: 3 }, { C: 2, D: 2 }, 3);
  assert.equal(best.total, 3);
  assert.deepEqual(best.xs, [2, 1], 'enumeration itself prefers C over D');

  const actual = actualAllocation(report);
  assert.deepEqual(actual.xs, { C: 2, D: 1 });
  assert.deepEqual(actual.ys, { C: { A: 2 }, D: { B: 1 } });
});
