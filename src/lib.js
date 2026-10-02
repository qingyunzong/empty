'use strict';

// Core library: relational division (candidates), min-cost award, incremental apply-change.
// Data model:
//   orders:   [{ order, process }]                 -- processes required by an order
//   machines: [{ machine, process, cert_expiry }]  -- cert_expiry === null means NO valid cert
//   costs:    [{ machine, shift_cost }]
//   budget:   number (total budget for the combination's summed shift_cost)

function requiredProcesses(orders, orderId) {
  const set = new Set();
  for (const row of orders) {
    if (row.order === orderId) set.add(row.process);
  }
  return [...set].sort();
}

// machine -> Set of processes backed by a valid (non-null) certificate.
// A null cert_expiry never passes any qualification check.
function qualifiedCapabilities(machines) {
  const caps = new Map();
  for (const row of machines) {
    if (row.cert_expiry === null || row.cert_expiry === undefined) continue;
    if (!caps.has(row.machine)) caps.set(row.machine, new Set());
    caps.get(row.machine).add(row.process);
  }
  return caps;
}

// Relational division: machines whose validly-certified processes intersect the
// order's required process set, together with the full requirement list.
function candidates(data, orderId) {
  const required = requiredProcesses(data.orders, orderId);
  const reqSet = new Set(required);
  const caps = qualifiedCapabilities(data.machines);
  const list = [];
  for (const [machine, procs] of caps) {
    const usable = [...procs].filter((p) => reqSet.has(p)).sort();
    if (usable.length > 0) list.push({ machine, processes: usable });
  }
  list.sort((a, b) => (a.machine < b.machine ? -1 : a.machine > b.machine ? 1 : 0));
  return { order: orderId, required, candidates: list };
}

// Combination ordering (cascading tie-breaks):
//   1. fewer machines wins
//   2. lower total cost wins
//   3. lexicographic order of the sorted machine-id list wins
// Machine count must be the primary key: otherwise a budget decrease could
// never invalidate an award in favour of a cheaper backup combination (the
// min-cost combination is feasible for every budget any other combination is
// feasible for), which the budget-cut acceptance scenario requires.
function compareSolutions(a, b) {
  if (a.machines.length !== b.machines.length) return a.machines.length - b.machines.length;
  if (a.cost !== b.cost) return a.cost - b.cost;
  for (let i = 0; i < a.machines.length; i += 1) {
    if (a.machines[i] !== b.machines[i]) return a.machines[i] < b.machines[i] ? -1 : 1;
  }
  return 0;
}

function costMap(costs) {
  return new Map(costs.map((c) => [c.machine, c.shift_cost]));
}

// Exact branch-and-bound over the candidate machines. Returns:
//   best:     best combination by compareSolutions with cost <= budget (or null)
//   cheapest: cheapest covering combination by (cost, lex) ignoring budget,
//             used as the minimal budget certificate (or null if uncoverable)
function searchCover(required, candList, costOf, budget) {
  const coverOf = candList.map((c) => new Set(c.processes));
  let best = null;
  let cheapest = null;
  const chosen = [];
  let chosenCost = 0;

  function lexLess(a, b) {
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) return a[i] < b[i];
    }
    return a.length < b.length;
  }

  function consider() {
    const machines = [...chosen].sort();
    if (cheapest === null || chosenCost < cheapest.cost ||
        (chosenCost === cheapest.cost && lexLess(machines, cheapest.machines))) {
      cheapest = { cost: chosenCost, machines };
    }
    if (chosenCost <= budget) {
      const sol = { cost: chosenCost, machines };
      if (best === null || compareSolutions(sol, best) < 0) best = sol;
    }
  }

  function dfs(uncovered) {
    if (uncovered.size === 0) {
      consider();
      return;
    }
    // Costs are non-negative: once over budget and unable to lower the minimum,
    // no completion of this branch can improve either answer.
    if (chosenCost > budget && cheapest !== null && chosenCost >= cheapest.cost) return;
    // Branch on the uncovered process with the fewest covering candidates.
    let target = null;
    let targetOptions = null;
    for (const p of uncovered) {
      const options = [];
      for (let i = 0; i < candList.length; i += 1) {
        if (!chosen.includes(candList[i].machine) && coverOf[i].has(p)) options.push(i);
      }
      if (options.length === 0) return; // dead end: p cannot be covered
      if (targetOptions === null || options.length < targetOptions.length) {
        target = p;
        targetOptions = options;
      }
    }
    for (const i of targetOptions) {
      const machine = candList[i].machine;
      const cost = costOf.get(machine);
      chosen.push(machine);
      chosenCost += cost;
      const next = new Set(uncovered);
      next.delete(target);
      for (const p of coverOf[i]) next.delete(p);
      dfs(next);
      chosen.pop();
      chosenCost -= cost;
    }
  }

  dfs(new Set(required));
  return { best, cheapest };
}

function infeasibleMissingCapability(missing) {
  return {
    status: 'infeasible',
    certificate: { type: 'missing_capability', processes: missing },
  };
}

function infeasibleBudget(cheapest, budget) {
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

// Select the best combination within budget covering all required processes.
// Never returns "pending": the result is either a full award certificate or an
// infeasible result carrying a minimal missing-capability / budget certificate.
function award(data, orderId, budgetOverride) {
  const budget = budgetOverride === undefined ? data.budget : budgetOverride;
  const { required, candidates: candList } = candidates(data, orderId);
  const costOf = costMap(data.costs);
  for (const c of candList) {
    if (!costOf.has(c.machine)) {
      throw new Error(`missing shift_cost for machine ${c.machine}`);
    }
  }
  const missing = required.filter((p) => !candList.some((c) => c.processes.includes(p)));
  if (missing.length > 0) return infeasibleMissingCapability(missing);

  const { best, cheapest } = searchCover(required, candList, costOf, budget);
  if (cheapest === null) {
    // Capability map said every process is coverable; defensive fallback.
    return infeasibleMissingCapability(required);
  }
  if (best === null) return infeasibleBudget(cheapest, budget);

  const chosen = best.machines;
  const coverOf = new Map(candList.map((c) => [c.machine, c.processes]));
  const allocation = required.map((p) => ({
    process: p,
    machine: chosen.find((m) => coverOf.get(m).includes(p)),
  }));
  return {
    status: 'awarded',
    order: orderId,
    machines: chosen,
    total_cost: best.cost,
    budget,
    allocation,
  };
}

function applyEvent(data, event) {
  if (event.type === 'revoke-cert') {
    const machines = data.machines.map((row) => {
      const machineMatch = row.machine === event.machine;
      const processMatch = event.process === undefined || row.process === event.process;
      if (machineMatch && processMatch) return { ...row, cert_expiry: null };
      return row;
    });
    return { ...data, machines };
  }
  if (event.type === 'budget') {
    return { ...data, budget: event.budget };
  }
  throw new Error(`unknown event type: ${event.type}`);
}

// Incremental change: withdraw the previous assignment, re-run the award on the
// updated state, and report the old->new diff plus the reassignment certificate.
function applyChange(data, orderId, events) {
  const eventList = Array.isArray(events) ? events : [events];
  const previous = award(data, orderId);
  let next = data;
  for (const event of eventList) next = applyEvent(next, event);
  const reassignment = award(next, orderId);

  const oldSet = previous.status === 'awarded' ? previous.machines : [];
  const newSet = reassignment.status === 'awarded' ? reassignment.machines : [];
  const removed = oldSet.filter((m) => !newSet.includes(m));
  const added = newSet.filter((m) => !oldSet.includes(m));

  return {
    order: orderId,
    events: eventList,
    withdrawn: {
      status: previous.status,
      machines: oldSet,
      total_cost: previous.status === 'awarded' ? previous.total_cost : null,
    },
    diff: { added, removed },
    reassignment,
  };
}

module.exports = {
  requiredProcesses,
  qualifiedCapabilities,
  candidates,
  compareSolutions,
  award,
  applyEvent,
  applyChange,
};
