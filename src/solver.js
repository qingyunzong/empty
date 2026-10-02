import { evalRule, ruleVars } from './rules.js';
import { DqError, BAD_INPUT, SEARCH_LIMIT } from './errors.js';
import { hash } from './canon.js';

// Domains are inclusive integer ranges: { varName: [lo, hi] }.
// Costs are per-unit-of-change: { varName: unitCost } (default 1).
// Repair cost of an assignment = sum(|new - old| * unitCost).

function prepare(data, domains, costs, rules) {
  const vars = Object.keys(domains).sort();
  for (const v of vars) {
    if (!Number.isInteger(data[v])) {
      throw new DqError(BAD_INPUT, `missing or non-integer value for variable ${v}`);
    }
    const d = domains[v];
    if (!Array.isArray(d) || !Number.isInteger(d[0]) || !Number.isInteger(d[1]) || d[0] > d[1]) {
      throw new DqError(BAD_INPUT, `invalid domain for variable ${v}`);
    }
  }
  const pos = new Map(vars.map((v, i) => [v, i]));
  const origin = vars.map((v) => data[v]);
  const unit = vars.map((v) => (costs && costs[v] !== undefined ? costs[v] : 1));
  const compiled = rules.map((rule) => {
    const names = ruleVars(rule);
    const idx = names.map((x) => {
      if (!pos.has(x)) {
        throw new DqError(BAD_INPUT, `rule ${rule.id} references unknown variable ${x}`);
      }
      return pos.get(x);
    });
    const indexOf = new Map(names.map((x, k) => [x, idx[k]]));
    return { rule, idx, indexOf };
  });
  return { vars, pos, origin, unit, compiled };
}

// Evaluate a compiled rule against the values array (all rule vars assigned).
function evalEntry(entry, values) {
  return evalRule(entry.rule, (x) => values[entry.indexOf.get(x)]);
}

// Exact minimum-cost repair. Enumerates the full (finite) search space with
// sound pruning only:
//   - drop a branch when a rule whose variables are all assigned is violated
//   - drop a branch whose cost cannot beat the incumbent or exceeds budget
// Returns { feasible:false } ONLY after the whole space was enumerated, so
// NO_FEASIBLE is a proof of infeasibility, never a timeout. If maxNodes is
// exceeded the search aborts with SEARCH_LIMIT instead.
export function optimalRepair({ data, domains, costs = {}, rules, budget = null, maxNodes = Infinity }) {
  const { vars, origin, unit, compiled } = prepare(data, domains, costs, rules);
  const budgetCap = budget === null || budget === undefined ? Infinity : budget;
  const values = new Array(vars.length);
  // Rules checked when variable i is assigned: those whose last variable is i.
  const maxPos = compiled.map((c) => Math.max(...c.idx));
  const rulesAt = vars.map((_, i) => compiled.filter((_, j) => maxPos[j] === i));
  let nodes = 0;
  let best = null;
  let bestCost = Infinity;

  function dfs(i, cost) {
    if (cost >= bestCost || cost > budgetCap) return;
    if (++nodes > maxNodes) {
      throw new DqError(SEARCH_LIMIT,
        `search aborted after ${maxNodes} nodes; infeasibility NOT proven`, { nodes });
    }
    if (i === vars.length) {
      best = values.slice();
      bestCost = cost;
      return;
    }
    const [lo, hi] = domains[vars[i]];
    for (let v = lo; v <= hi; v++) {
      values[i] = v;
      const c = cost + Math.abs(v - origin[i]) * unit[i];
      if (c >= bestCost || c > budgetCap) continue;
      let ok = true;
      for (const entry of rulesAt[i]) {
        if (!evalEntry(entry, values)) { ok = false; break; }
      }
      if (ok) dfs(i + 1, c);
    }
  }
  dfs(0, 0);

  if (!best) return { feasible: false, nodes };
  const assignment = {};
  vars.forEach((v, i) => { assignment[v] = best[i]; });
  return { feasible: true, assignment, cost: bestCost, nodes };
}

// Enumerate repair plans (assignments with cost <= budget), including partial
// fixes. Ranked deterministically by:
//   1. fixed violations (descending)
//   2. cost (ascending)
//   3. plan hash (ascending)
export function enumeratePlans({ data, domains, costs = {}, rules, budget = null, limit = 10, maxNodes = 1_000_000 }) {
  const { vars, origin, unit, compiled } = prepare(data, domains, costs, rules);
  const budgetCap = budget === null || budget === undefined ? Infinity : budget;
  const values = new Array(vars.length);
  const originViolations = compiled.filter((e) => !evalRule(e.rule, (x) => data[x])).length;
  let nodes = 0;
  let complete = true;
  const plans = [];

  function dfs(i, cost) {
    if (cost > budgetCap || !complete) return;
    if (++nodes > maxNodes) { complete = false; return; }
    if (i === vars.length) {
      const remaining = compiled.filter((e) => !evalEntry(e, values)).map((e) => e.rule.id);
      const assignment = {};
      vars.forEach((v, j) => { assignment[v] = values[j]; });
      plans.push({
        assignment,
        cost,
        fixedViolations: originViolations - remaining.length,
        remainingViolations: remaining,
        hash: hash(assignment),
      });
      return;
    }
    const [lo, hi] = domains[vars[i]];
    for (let v = lo; v <= hi; v++) {
      values[i] = v;
      dfs(i + 1, cost + Math.abs(v - origin[i]) * unit[i]);
    }
  }
  dfs(0, 0);

  plans.sort((a, b) =>
    b.fixedViolations - a.fixedViolations ||
    a.cost - b.cost ||
    (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));

  return {
    plans: plans.slice(0, limit),
    total: plans.length,
    complete,
    nodes,
    ranking: 'fixedViolations desc, cost asc, hash asc',
  };
}
