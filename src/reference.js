'use strict';

// Independent reference implementation: for <= 12 machines, enumerate EVERY
// subset of candidate machines and pick the best feasible one. Used to
// cross-check the branch-and-bound in src/lib.js. Comparators are written
// out inline so the reference shares no selection logic with the main code.

const { requiredProcesses, qualifiedCapabilities } = require('./lib');

// Same contract as lib.compareSolutions: fewer machines, then lower cost,
// then lexicographic order of sorted machine ids.
function refCompare(a, b) {
  if (a.machines.length !== b.machines.length) return a.machines.length - b.machines.length;
  if (a.cost !== b.cost) return a.cost - b.cost;
  for (let i = 0; i < a.machines.length; i += 1) {
    if (a.machines[i] !== b.machines[i]) return a.machines[i] < b.machines[i] ? -1 : 1;
  }
  return 0;
}

function refLexLess(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return a.length < b.length;
}

function referenceAward(data, orderId, budgetOverride) {
  const budget = budgetOverride === undefined ? data.budget : budgetOverride;
  const required = requiredProcesses(data.orders, orderId);
  const reqSet = new Set(required);
  const caps = qualifiedCapabilities(data.machines);
  const costOf = new Map(data.costs.map((c) => [c.machine, c.shift_cost]));

  const candList = [];
  for (const [machine, procs] of caps) {
    const usable = [...procs].filter((p) => reqSet.has(p));
    if (usable.length > 0) candList.push({ machine, processes: usable });
  }
  candList.sort((a, b) => (a.machine < b.machine ? -1 : 1));
  if (candList.length > 12) {
    throw new Error(`reference enumeration limited to 12 machines, got ${candList.length}`);
  }

  const missing = required.filter((p) => !candList.some((c) => c.processes.includes(p)));
  if (missing.length > 0) {
    return { status: 'infeasible', certificate: { type: 'missing_capability', processes: missing } };
  }

  let best = null; // best by refCompare among subsets with cost <= budget
  let cheapest = null; // cheapest covering subset by (cost, lex), any budget
  const n = candList.length;
  for (let mask = 0; mask < (1 << n); mask += 1) {
    const covered = new Set();
    const machines = [];
    let cost = 0;
    for (let i = 0; i < n; i += 1) {
      if (mask & (1 << i)) {
        machines.push(candList[i].machine);
        cost += costOf.get(candList[i].machine);
        for (const p of candList[i].processes) covered.add(p);
      }
    }
    if (!required.every((p) => covered.has(p))) continue;
    machines.sort();
    if (cheapest === null || cost < cheapest.cost ||
        (cost === cheapest.cost && refLexLess(machines, cheapest.machines))) {
      cheapest = { cost, machines };
    }
    if (cost <= budget) {
      const sol = { cost, machines };
      if (best === null || refCompare(sol, best) < 0) best = sol;
    }
  }

  if (cheapest === null) {
    return { status: 'infeasible', certificate: { type: 'missing_capability', processes: required } };
  }
  if (best === null) {
    return {
      status: 'infeasible',
      certificate: {
        type: 'budget',
        budget,
        min_cost: cheapest.cost,
        deficit: cheapest.cost - budget,
        cheapest_combination: cheapest.machines,
      },
    };
  }
  return { status: 'awarded', machines: best.machines, total_cost: best.cost, budget };
}

module.exports = { referenceAward };
