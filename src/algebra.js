import { EvpackError, E_INVALID } from './errors.js';

export const isNull = (v) => v === null || v === undefined;

export const PRED_OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'exists'];
export const AGG_OPS = ['count', 'sum', 'min', 'max'];
export const EXPECT_OPS = ['lt', 'lte', 'gt', 'gte'];

// Restricted relational algebra: sigma (where) -> gamma (aggregate) -> expect.
// NULL semantics: a predicate over a missing/NULL field is never TRUE
// (except 'exists'), so such rows are not selected.
export function matchPred(attrs, pred) {
  if (!pred || typeof pred.field !== 'string' || pred.field === '') {
    throw new EvpackError(E_INVALID, 'predicate requires a non-empty "field"');
  }
  if (!PRED_OPS.includes(pred.op)) {
    throw new EvpackError(E_INVALID, `unknown predicate op: ${pred.op}`);
  }
  const v = attrs[pred.field];
  switch (pred.op) {
    case 'exists': return pred.value === false ? isNull(v) : !isNull(v);
    case 'eq': return !isNull(v) && v === pred.value;
    case 'ne': return !isNull(v) && v !== pred.value;
    case 'lt': return !isNull(v) && v < pred.value;
    case 'lte': return !isNull(v) && v <= pred.value;
    case 'gt': return !isNull(v) && v > pred.value;
    case 'gte': return !isNull(v) && v >= pred.value;
    case 'in': return !isNull(v) && Array.isArray(pred.value) && pred.value.includes(v);
    default: throw new EvpackError(E_INVALID, `unknown predicate op: ${pred.op}`);
  }
}

export function matchWhere(attrs, where = []) {
  return where.every((p) => matchPred(attrs, p));
}

// Three-valued expectation: NULL aggregate value -> 'unknown' (never false).
export function applyExpect(op, value, target) {
  if (isNull(value)) return 'unknown';
  switch (op) {
    case 'lt': return value < target;
    case 'lte': return value <= target;
    case 'gt': return value > target;
    case 'gte': return value >= target;
    default: throw new EvpackError(E_INVALID, `unknown expect op: ${op}`);
  }
}

export function validateWhere(where) {
  if (!Array.isArray(where)) throw new EvpackError(E_INVALID, '"where" must be an array of predicates');
  for (const p of where) matchPred({}, p); // validates shape/op
}

export function validateClaim(claim) {
  if (!claim || typeof claim !== 'object') throw new EvpackError(E_INVALID, 'claim must be an object');
  const agg = claim.aggregate;
  if (!agg || !AGG_OPS.includes(agg.op)) {
    throw new EvpackError(E_INVALID, `claim.aggregate.op must be one of ${AGG_OPS.join(',')}`);
  }
  if (agg.field !== undefined && typeof agg.field !== 'string') {
    throw new EvpackError(E_INVALID, 'claim.aggregate.field must be a string');
  }
  const expect = claim.expect;
  if (!expect || !EXPECT_OPS.includes(expect.op) || typeof expect.value !== 'number') {
    throw new EvpackError(E_INVALID, `claim.expect requires op in ${EXPECT_OPS.join(',')} and numeric value`);
  }
  validateWhere(claim.where ?? []);
}
