export class DqError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'DqError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const RULE_CYCLE = 'RULE_CYCLE';
export const NO_FEASIBLE = 'NO_FEASIBLE';
export const HISTORY_CONFLICT = 'HISTORY_CONFLICT';
export const SEARCH_LIMIT = 'SEARCH_LIMIT';
export const BAD_INPUT = 'BAD_INPUT';

export function ruleCycle(cycle) {
  return new DqError(RULE_CYCLE, `rule dependency cycle detected: ${cycle.join(' -> ')}`, { cycle });
}

export function noFeasible(budget, states) {
  return new DqError(
    NO_FEASIBLE,
    `exhaustive search over ${states} states proved no plan with cost <= ${budget} exists`,
    { budget, states }
  );
}

export function historyConflict(conflicts) {
  return new DqError(
    HISTORY_CONFLICT,
    `concurrent versions changed the same variables differently: ${conflicts.map((c) => c.var).join(', ')}`,
    { conflicts }
  );
}

export function searchLimit(maxStates) {
  return new DqError(
    SEARCH_LIMIT,
    `search aborted after ${maxStates} states; feasibility is UNKNOWN (this is not a proof of infeasibility)`,
    { maxStates }
  );
}

export function badInput(message, details) {
  return new DqError(BAD_INPUT, message, details);
}
