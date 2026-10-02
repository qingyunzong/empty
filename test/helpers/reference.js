// Independent naive reference used for differential testing ("对拍").
// It shares only the predicate/aggregate primitives (the spec) with the
// engine; the evaluation strategy is deliberately brute force: enumerate
// every subset of pending (unknown/retracted) evidence rows, rebuild the
// full row set for each completion, re-apply all rules row by row, and
// aggregate from scratch.
import { evalPred, aggregateRows, compare } from '../../src/algebra.js';

export function referenceEvaluate(evidenceRows, rules, claim) {
  const select = claim.select ?? { op: 'true' };
  const agg = claim.aggregate ?? { op: 'count', field: '*' };

  const relevant = [];
  const pending = [];
  for (const row of evidenceRows) {
    const p = evalPred(select, row.fields);
    if (row.status === 'asserted' && p === true) relevant.push(row);
    else if (row.status !== 'asserted' && p !== false) pending.push(row);
  }

  const excludedByRule = {};
  const included = [];
  for (const row of relevant) {
    const hits = rules.filter((r) => evalPred(r.when, row.fields) === true);
    if (hits.length === 0) included.push(row);
    for (const h of hits) {
      if (!excludedByRule[h.id]) excludedByRule[h.id] = [];
      excludedByRule[h.id].push(row.key);
    }
  }
  for (const id of Object.keys(excludedByRule)) excludedByRule[id].sort();

  const pendingLive = pending.filter(
    (row) => !rules.some((r) => evalPred(r.when, row.fields) === true),
  );

  const firedIds = Object.keys(excludedByRule);
  let appliedRules = [];
  if (firedIds.length > 0) {
    const prio = (id) => rules.find((r) => r.id === id).priority ?? 0;
    const best = Math.max(...firedIds.map(prio));
    appliedRules = firedIds.filter((id) => prio(id) === best).sort();
  }

  const outcomes = new Set();
  const k = pendingLive.length;
  for (let mask = 0; mask < 1 << k; mask += 1) {
    const rows = [...included];
    for (let i = 0; i < k; i += 1) {
      if ((mask >> i) & 1) rows.push(pendingLive[i]);
    }
    const c = compare(aggregateRows(agg, rows), claim.cmp);
    outcomes.add(c === null ? 'unknown' : String(c));
  }
  const conclusion =
    outcomes.size === 1 && outcomes.has('true')
      ? 'pass'
      : outcomes.size === 1 && outcomes.has('false')
        ? 'fail'
        : 'undecided';

  return {
    conclusion,
    hitEvidenceKeys: included.map((r) => r.key).sort(),
    undecided: pendingLive.map((r) => r.key).sort(),
    appliedRules,
    excludedByRule,
  };
}

// Deterministic PRNG (mulberry32) for reproducible randomized tests.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
