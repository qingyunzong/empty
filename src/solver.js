// Solver: exact enumeration of integer-gram recipes (in units of `step`)
// with branch-and-bound pruning. Objective: minimize total cost.
// Tie-breaks, in order: lower allergen total, then the lexicographically
// smaller gram vector with ingredients ordered by name (ascending
// enumeration guarantees the first such plan found wins).
import { run } from './vm.js';

const EPS = 1e-9;

export function solve(prog) {
  const n = prog.n;
  const step = prog.stepG;
  const U = prog.targetG / step;
  const cap = prog.capsG.map((s) => Math.floor(s / step));
  const order = [...Array(n).keys()].sort((a, b) =>
    prog.names[a] < prog.names[b] ? -1 : prog.names[a] > prog.names[b] ? 1 : 0,
  );

  const unitCost = prog.objectiveAff.c.map((c) => c * step);
  const cons = prog.constraints.map((c) => {
    const cu = c.aff.c.map((x) => x * step);
    let test;
    if (c.kind === 'range') {
      test = (v) => v >= c.lo - EPS && v <= c.hi + EPS;
    } else {
      const ops = {
        '<': (v) => v < -EPS,
        '<=': (v) => v <= EPS,
        '>': (v) => v > EPS,
        '>=': (v) => v >= -EPS,
        '==': (v) => Math.abs(v) <= EPS,
      };
      test = ops[c.op];
    }
    return { k: c.aff.k, cu, test, con: c };
  });

  const m = order.length;
  const sufMinCost = new Array(m + 1).fill(0);
  for (let p = m - 1; p >= 0; p--) {
    sufMinCost[p] = Math.min(sufMinCost[p + 1], unitCost[order[p]]);
  }
  const sufMin = cons.map(() => new Array(m + 1).fill(0));
  const sufMax = cons.map(() => new Array(m + 1).fill(0));
  cons.forEach((c, ci) => {
    for (let p = m - 1; p >= 0; p--) {
      const coef = c.cu[order[p]];
      sufMin[ci][p] = Math.min(sufMin[ci][p + 1], coef);
      sufMax[ci][p] = Math.max(sufMax[ci][p + 1], coef);
    }
  });

  const units = new Array(n).fill(0);
  const partial = cons.map((c) => c.k);
  let best = null;

  const dfs = (pos, remaining, costSoFar) => {
    if (best && costSoFar + remaining * sufMinCost[pos] > best.costMicro) return;
    for (let ci = 0; ci < cons.length; ci++) {
      const c = cons[ci];
      const lo = partial[ci] + Math.min(0, sufMin[ci][pos]) * remaining;
      const hi = partial[ci] + Math.max(0, sufMax[ci][pos]) * remaining;
      if (c.con.kind === 'range') {
        if (hi < c.con.lo - EPS || lo > c.con.hi + EPS) return;
      } else if (c.con.op === '<=' || c.con.op === '<') {
        if (lo > EPS) return;
      } else if (c.con.op === '>=' || c.con.op === '>') {
        if (hi < -EPS) return;
      } else if (lo > EPS || hi < -EPS) {
        return;
      }
    }
    if (pos === m) {
      if (remaining !== 0) return;
      const grams = units.map((u) => u * step);
      for (const c of prog.constraints) {
        if (!run(c.code, grams)) return;
      }
      const costMicro = run(prog.objectiveCode, grams);
      const allergenTotal = run(prog.allergenCode, grams);
      if (
        !best ||
        costMicro < best.costMicro ||
        (costMicro === best.costMicro && allergenTotal < best.allergenTotal)
      ) {
        best = { grams, costMicro, allergenTotal };
      }
      return;
    }
    const i = order[pos];
    const maxU = Math.min(cap[i], remaining);
    for (let u = 0; u <= maxU; u++) {
      units[i] = u;
      for (let ci = 0; ci < cons.length; ci++) partial[ci] += u * cons[ci].cu[i];
      dfs(pos + 1, remaining - u, costSoFar + u * unitCost[i]);
      for (let ci = 0; ci < cons.length; ci++) partial[ci] -= u * cons[ci].cu[i];
    }
    units[i] = 0;
  };

  dfs(0, U, 0);
  if (!best) return { status: 'INFEASIBLE' };
  return { status: 'OPTIMAL', ...best };
}
