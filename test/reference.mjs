// Independent brute-force reference implementation for differential testing.
// It enumerates ALL subsets of the uncertain (unknown + retracted) matching
// rows, computes the aggregate for each subset, and derives the three-valued
// conclusion directly from the achievable set:
//   pass      <- expectation TRUE for every achievable value
//   fail      <- expectation FALSE for every achievable value
//   undecided <- otherwise (including any achievable NULL)

function isNull(v) {
  return v === null || v === undefined;
}

function refMatchPred(attrs, pred) {
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
    default: throw new Error(`ref: bad pred op ${pred.op}`);
  }
}

function refMatchWhere(attrs, where) {
  return (where ?? []).every((p) => refMatchPred(attrs, p));
}

function refExpect(op, value, target) {
  if (isNull(value)) return 'unknown';
  switch (op) {
    case 'lt': return value < target;
    case 'lte': return value <= target;
    case 'gt': return value > target;
    case 'gte': return value >= target;
    default: throw new Error(`ref: bad expect op ${op}`);
  }
}

// rows: [{ key, state, attrs }], rules: [{ id, priority, where }]
export function refEvaluate(rows, rules, claim) {
  const where = claim.where ?? [];
  const candidates = rows.filter((r) => refMatchWhere(r.attrs, where));
  const pool = candidates.filter((c) => !rules.some((rule) => refMatchWhere(c.attrs, rule.where)));
  const asserted = pool.filter((r) => r.state === 'asserted');
  const uncertain = pool.filter((r) => r.state !== 'asserted'); // unknown + retracted

  const field = claim.aggregate.field ?? '*';
  const valuesOf = (list) =>
    field === '*' ? [] : list.map((r) => r.attrs[field]).filter((v) => !isNull(v));
  const compute = (list) => {
    const vals = valuesOf(list);
    switch (claim.aggregate.op) {
      case 'count': return field === '*' ? list.length : vals.length;
      case 'sum': return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
      case 'min': return vals.length ? Math.min(...vals) : null;
      case 'max': return vals.length ? Math.max(...vals) : null;
      default: throw new Error(`ref: bad agg ${claim.aggregate.op}`);
    }
  };

  let anyTrue = false;
  let anyFalse = false;
  let anyUnknown = false;
  const n = uncertain.length;
  if (n > 24) throw new Error('ref: too many uncertain rows to enumerate');
  for (let mask = 0; mask < 2 ** n; mask++) {
    const subset = asserted.slice();
    for (let i = 0; i < n; i++) if (mask & (1 << i)) subset.push(uncertain[i]);
    const res = refExpect(claim.expect.op, compute(subset), claim.expect.value);
    if (res === 'unknown') anyUnknown = true;
    else if (res) anyTrue = true;
    else anyFalse = true;
  }
  const conclusion = anyUnknown || (anyTrue && anyFalse) ? 'undecided' : anyTrue ? 'pass' : 'fail';
  return {
    conclusion,
    hits: asserted.map((r) => r.key).sort(),
    undecided: uncertain.filter((r) => r.state === 'unknown').map((r) => r.key).sort(),
    retracted: uncertain.filter((r) => r.state === 'retracted').map((r) => r.key).sort(),
  };
}
