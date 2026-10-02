import { topoOrder, evaluateRule } from './rules.js';
import { contentHash } from './stableJson.js';
import { searchLimit, badInput } from './errors.js';

export const DEFAULT_MAX_STATES = 2_000_000;

function changeCost(spec, from, to) {
  if (from === to) return 0;
  if (spec.costPerUnit !== undefined) return spec.costPerUnit * Math.abs(to - from);
  return spec.changeCost ?? 1;
}

function validateSchema(data, schema) {
  for (const [name, spec] of Object.entries(schema)) {
    if (!Array.isArray(spec.domain) || spec.domain.length === 0) {
      throw badInput(`schema.${name}: domain must be a non-empty array`);
    }
    if (!(name in data)) throw badInput(`data is missing variable ${name}`);
  }
}

function makePlan(data, schema, assign, violations, totalRules, budget) {
  const changes = [];
  let cost = 0;
  for (const name of Object.keys(schema).sort()) {
    if (assign[name] !== data[name]) {
      const c = changeCost(schema[name], data[name], assign[name]);
      changes.push({ var: name, from: data[name], to: assign[name], cost: c });
      cost += c;
    }
  }
  const resolved = totalRules - violations.length;
  return {
    assign: { ...assign },
    changes,
    cost,
    resolved,
    violations: violations.map((v) => v.rule),
    feasible: violations.length === 0 && cost <= budget,
    hash: null, // computed lazily by planHash()
  };
}

// Hash is computed lazily: sha256 per enumerated state is too expensive,
// and the hash only matters when (resolved, cost) tie.
export function planHash(plan) {
  if (plan.hash === null) plan.hash = contentHash({ changes: plan.changes, cost: plan.cost });
  return plan.hash;
}

// Deterministic plan ranking: resolved violations DESC, cost ASC, hash ASC.
export function comparePlans(a, b) {
  if (a.resolved !== b.resolved) return b.resolved - a.resolved;
  if (a.cost !== b.cost) return a.cost - b.cost;
  const ah = planHash(a);
  const bh = planHash(b);
  return ah < bh ? -1 : ah > bh ? 1 : 0;
}

function insertRanked(list, plan, cap) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (comparePlans(plan, list[mid]) < 0) hi = mid;
    else lo = mid + 1;
  }
  if (lo >= cap) return;
  list.splice(lo, 0, plan);
  if (list.length > cap) list.pop();
}

// Exhaustive enumeration over the Cartesian product of variable domains.
// NO_FEASIBLE may only be concluded by the caller when this returns with
// exhausted === true and best === null. Hitting maxStates throws SEARCH_LIMIT,
// which is never a proof of infeasibility.
export function searchPlans({ data, schema, rules, budget = Infinity, maxStates = DEFAULT_MAX_STATES, maxPlans = 10 }) {
  validateSchema(data, schema);
  const order = topoOrder(rules); // throws RULE_CYCLE before any search
  const byId = new Map(rules.map((r) => [r.id, r]));
  const orderedRules = order.map((id) => byId.get(id));
  const names = Object.keys(schema).sort();
  const domains = names.map((n) => schema[n].domain);
  const top = [];
  let best = null;
  let states = 0;
  const assign = {};

  function visit(idx) {
    if (idx === names.length) {
      states += 1;
      if (states > maxStates) throw searchLimit(maxStates);
      const violations = [];
      for (const rule of orderedRules) {
        const v = evaluateRule(rule, assign);
        if (v) violations.push(v);
      }
      const plan = makePlan(data, schema, assign, violations, rules.length, budget);
      insertRanked(top, plan, maxPlans);
      if (plan.feasible) {
        if (best === null || plan.cost < best.cost || (plan.cost === best.cost && planHash(plan) < planHash(best))) {
          best = plan;
        }
      }
      return;
    }
    const name = names[idx];
    for (const value of domains[idx]) {
      assign[name] = value;
      visit(idx + 1);
    }
  }
  visit(0);
  for (const p of top) planHash(p);
  if (best) planHash(best);
  return { plans: top, best, states, exhausted: true, budget };
}
