// Solver: enumerates integer-gram recipes on the step grid with
// branch-and-bound on the exact rational cost, evaluates constraints and the
// objective on the VM, and applies the deterministic tie-break ladder:
//   1. lower total cost
//   2. lower total allergen
//   3. lexicographically smaller sorted list of used ingredient names
//   4. lexicographically smaller gram vector (ingredients in name order)

import { run, VMError } from './vm.js';
import { rat, radd, rmul, rsub, rabs, rcmp, rfloor, RZERO } from './rational.js';

function compareNameLists(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

export function comparePlans(a, b) {
  let c = rcmp(a.cost, b.cost);
  if (c !== 0) return c;
  c = rcmp(a.allergen, b.allergen);
  if (c !== 0) return c;
  c = compareNameLists(a.support, b.support);
  if (c !== 0) return c;
  const n = a.sortedGrams.length;
  for (let i = 0; i < n; i++) {
    if (a.sortedGrams[i] !== b.sortedGrams[i]) return a.sortedGrams[i] < b.sortedGrams[i] ? -1 : 1;
  }
  return 0;
}

function satisfies(op, cmp) {
  switch (op) {
    case '<=': return cmp <= 0;
    case '>=': return cmp >= 0;
    case '==': return cmp === 0;
    case '<': return cmp < 0;
    case '>': return cmp > 0;
    default: throw new Error(`bad comparison op ${op}`);
  }
}

export function solve(model, compiled) {
  const names = model.ingredients.map((i) => i.name);
  const n = names.length;

  const total = model.total;
  const step = model.step;
  const units = Number(total.n / step.n);
  const stepG = Number(step.n);

  const costs = model.ingredients.map((i) => i.attrs.get('cost').value); // CNY per gram
  const allergens = model.ingredients.map((i) => i.attrs.get('allergen').value);
  const caps = model.ingredients.map((ing, i) => {
    const stock = ing.attrs.get('stock').value;
    const stockG = rfloor(stock); // stock dimension is mass-in-grams
    const capUnits = Number(stockG / step.n);
    return Math.min(capUnits, units);
  });

  const grams = new Array(n).fill(0);
  const chosen = new Array(n).fill(0);

  let best = null; // { grams, cost, allergen, support, sortedGrams }
  let evaluated = 0;

  const consider = () => {
    evaluated++;
    for (const c of compiled.constraints) {
      let lhs;
      let rhs;
      try {
        lhs = run(c.lhs, grams);
        rhs = run(c.rhs, grams);
      } catch (e) {
        if (e instanceof VMError) return; // e.g. division by zero: candidate invalid
        throw e;
      }
      if (!satisfies(c.op, rcmp(lhs, rhs))) return;
    }
    let cost;
    try {
      cost = run(compiled.objective, grams);
    } catch (e) {
      if (e instanceof VMError) return;
      throw e;
    }
    let allergen = RZERO;
    for (let i = 0; i < n; i++) {
      if (grams[i] !== 0) allergen = radd(allergen, rmul(allergens[i], rat(BigInt(grams[i]))));
    }
    const support = names.filter((_, i) => grams[i] > 0).sort();
    const sortedGrams = names
      .map((name, i) => [name, grams[i]])
      .sort((x, y) => (x[0] < y[0] ? -1 : 1))
      .map(([, g]) => g);
    const candidate = { grams: grams.slice(), cost, allergen, support, sortedGrams };
    if (!best || comparePlans(candidate, best) < 0) best = candidate;
  };

  // Greedy cheapest-fill lower bound for the remaining `rest` units using
  // ingredients idx..n-1 with their caps. Valid because costs are >= 0.
  const costPerUnit = costs.map((c) => rmul(c, rat(BigInt(stepG))));
  const lowerBound = (idx, rest, partialCost) => {
    const order = [];
    for (let j = idx; j < n; j++) order.push(j);
    order.sort((a, b) => rcmp(costPerUnit[a], costPerUnit[b]));
    let bound = partialCost;
    let left = rest;
    for (const j of order) {
      if (left === 0) break;
      const take = Math.min(left, caps[j]);
      if (take > 0) {
        bound = radd(bound, rmul(costPerUnit[j], rat(BigInt(take))));
        left -= take;
      }
    }
    return bound;
  };

  const search = (idx, rest, partialCost) => {
    if (idx === n) {
      if (rest === 0) consider();
      return;
    }
    if (best && rcmp(lowerBound(idx, rest, partialCost), best.cost) > 0) return;
    const maxTake = Math.min(caps[idx], rest);
    for (let k = 0; k <= maxTake; k++) {
      grams[idx] = k * stepG;
      chosen[idx] = k;
      search(idx + 1, rest - k, radd(partialCost, rmul(costPerUnit[idx], rat(BigInt(k)))));
    }
    grams[idx] = 0;
    chosen[idx] = 0;
  };

  search(0, units, RZERO);

  if (!best) return { status: 'INFEASIBLE', evaluated };

  const margins = compiled.constraints.map((c) => {
    const lhs = run(c.lhs, best.grams);
    const rhs = run(c.rhs, best.grams);
    let slack;
    if (c.op === '<=' || c.op === '<') slack = rsub(rhs, lhs);
    else if (c.op === '>=' || c.op === '>') slack = rsub(lhs, rhs);
    else slack = rabs(rsub(lhs, rhs));
    return { line: c.line, op: c.op, lhs, rhs, margin: slack };
  });

  const plan = {
    grams: Object.fromEntries(names.map((name, i) => [name, best.grams[i]])),
    cost: best.cost,
    allergen: best.allergen,
    margins,
  };

  if (model.budget && rcmp(best.cost, model.budget) > 0) {
    return { status: 'OVER_BUDGET', plan, budget: model.budget, evaluated };
  }
  return { status: 'OPTIMAL', plan, budget: model.budget ?? null, evaluated };
}
