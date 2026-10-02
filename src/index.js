export { DqError, RULE_CYCLE, NO_FEASIBLE, HISTORY_CONFLICT, SEARCH_LIMIT, BAD_INPUT } from './errors.js';
export { canonical, hash } from './canon.js';
export * as vectorClock from './vector.js';
export { ruleVars, evalRule, topoSort, checkData } from './rules.js';
export { optimalRepair, enumeratePlans } from './solver.js';
export { genesis, applyRepair, mergeVersions, resolveData, isVersion } from './version.js';
export { explain } from './explain.js';
