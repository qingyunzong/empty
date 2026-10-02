import { applyExpect, validateClaim, isNull } from './algebra.js';
import { EvpackError, E_INVALID } from './errors.js';

// Three-valued claim evaluation.
//
//   asserted  rows: definitely present      -> contribute to both bounds
//   unknown   rows: presence undecided      -> widen [lo, hi]; never "absent"
//   retracted rows: withdrawn, not disproven -> widen [lo, hi]; never "absent"
//
// The conclusion is 'pass' iff the expectation holds for every achievable
// aggregate value, 'fail' iff it holds for none, otherwise 'undecided'.
// A NULL aggregate (empty set for sum/min/max) is achievable whenever no
// asserted row carries a non-NULL aggregate field, and forces 'undecided':
// unknown/NULL is never treated as unsatisfiable.

function bounds(store, agg, assertedKeys, uncertainKeys) {
  const field = agg.field ?? '*';
  const val = (k) => store.evidence.get(k).attrs[field];
  if (agg.op === 'count') {
    if (field === '*') {
      return { lo: assertedKeys.length, hi: assertedKeys.length + uncertainKeys.length, nullPossible: false };
    }
    const lo = assertedKeys.filter((k) => !isNull(val(k))).length;
    const hi = lo + uncertainKeys.filter((k) => !isNull(val(k))).length;
    return { lo, hi, nullPossible: false };
  }
  const aVals = assertedKeys.map(val).filter((v) => !isNull(v));
  const uVals = uncertainKeys.map(val).filter((v) => !isNull(v));
  for (const v of [...aVals, ...uVals]) {
    if (typeof v !== 'number') {
      throw new EvpackError(E_INVALID, `aggregate '${agg.op}' requires numeric field '${field}'`);
    }
  }
  if (aVals.length === 0) {
    // An empty subset of the uncertain rows is achievable -> NULL is achievable.
    return { lo: null, hi: null, nullPossible: true };
  }
  if (agg.op === 'sum') {
    const sumA = aVals.reduce((a, b) => a + b, 0);
    const neg = uVals.filter((v) => v < 0).reduce((a, b) => a + b, 0);
    const pos = uVals.filter((v) => v > 0).reduce((a, b) => a + b, 0);
    return { lo: sumA + neg, hi: sumA + pos, nullPossible: false };
  }
  if (agg.op === 'min') {
    const minA = Math.min(...aVals);
    return { lo: uVals.length ? Math.min(minA, ...uVals) : minA, hi: minA, nullPossible: false };
  }
  // max
  const maxA = Math.max(...aVals);
  return { lo: maxA, hi: uVals.length ? Math.max(maxA, ...uVals) : maxA, nullPossible: false };
}

function decide(lo, hi, nullPossible, expect) {
  if (nullPossible) return 'undecided';
  const tLo = applyExpect(expect.op, lo, expect.value);
  const tHi = applyExpect(expect.op, hi, expect.value);
  if (tLo === true && tHi === true) return 'pass';
  if (tLo === false && tHi === false) return 'fail';
  return 'undecided';
}

export function evaluateClaim(store, claim) {
  validateClaim(claim);
  const where = claim.where ?? [];
  const { keys, scanned } = store.candidates(where);
  const excluded = {}; // key -> [ruleId]
  const asserted = [];
  const unknown = [];
  const retracted = [];
  const firedRuleIds = new Set();
  for (const key of keys) {
    const ruleIds = store.keyToRules.get(key);
    if (ruleIds && ruleIds.size > 0) {
      excluded[key] = [...ruleIds].sort();
      for (const id of ruleIds) firedRuleIds.add(id);
      continue;
    }
    const state = store.evidence.get(key).state;
    if (state === 'asserted') asserted.push(key);
    else if (state === 'unknown') unknown.push(key);
    else retracted.push(key);
  }
  const uncertain = [...unknown, ...retracted];
  const { lo, hi, nullPossible } = bounds(store, claim.aggregate, asserted, uncertain);
  const conclusion = decide(lo, hi, nullPossible, claim.expect);
  // All top-priority rules that fired; ties are listed in full, sorted by id.
  let bestRules = [];
  if (firedRuleIds.size > 0) {
    const fired = store.rules.filter((r) => firedRuleIds.has(r.id));
    const top = Math.max(...fired.map((r) => r.priority));
    bestRules = fired
      .filter((r) => r.priority === top)
      .map((r) => ({ id: r.id, priority: r.priority }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }
  return {
    conclusion,
    aggregate: {
      op: claim.aggregate.op,
      field: claim.aggregate.field ?? '*',
      lo,
      hi,
      null: nullPossible,
      value: !nullPossible && lo === hi ? lo : null,
    },
    hits: asserted,
    undecided: unknown,
    retracted,
    excluded,
    bestRules,
    scanned,
    inputHash: store.inputHash(),
    ruleVersion: store.ruleVersion,
  };
}
