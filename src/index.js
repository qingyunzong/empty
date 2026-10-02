import { checkData } from './rules.js';
import { searchPlans, DEFAULT_MAX_STATES } from './plan.js';
import { createBaseVersion, applyRepair, mergeVersions } from './version.js';
import { explain } from './explain.js';
import { noFeasible, badInput } from './errors.js';

export { DqError, RULE_CYCLE, NO_FEASIBLE, HISTORY_CONFLICT, SEARCH_LIMIT } from './errors.js';
export { topoOrder, checkData, evaluateRule } from './rules.js';
export { searchPlans, comparePlans } from './plan.js';
export { createBaseVersion, applyRepair, mergeVersions } from './version.js';
export { explain } from './explain.js';
export { compare as compareClocks, mergeClocks, increment } from './vectorClock.js';

export function check({ data, version, rules }) {
  const values = data ?? version?.data;
  if (!values) throw badInput('check requires data or a version');
  return checkData(values, rules);
}

export function plan({ data, version, schema, rules, budget = Infinity, maxStates = DEFAULT_MAX_STATES, maxPlans = 10 }) {
  const values = data ?? version?.data;
  if (!values) throw badInput('plan requires data or a version');
  return searchPlans({ data: values, schema, rules, budget, maxStates, maxPlans });
}

// Repair produces a new causal successor version of the input version.
// Throws NO_FEASIBLE only after exhaustive enumeration proves that no
// plan with cost <= budget exists. SEARCH_LIMIT is never NO_FEASIBLE.
export function repair({ version, schema, rules, budget = Infinity, node = 'node0', maxStates = DEFAULT_MAX_STATES }) {
  if (!version) throw badInput('repair requires a version');
  const result = searchPlans({ data: version.data, schema, rules, budget, maxStates, maxPlans: 1 });
  if (result.best === null) {
    throw noFeasible(budget, result.states);
  }
  const child = applyRepair(version, result.best, node);
  return { version: child, plan: result.best, states: result.states };
}

export function merge({ base, a, b, node = 'merge' }) {
  return mergeVersions(base, a, b, node);
}
