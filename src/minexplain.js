"use strict";

const { stableStringify } = require("./canon");
const { rowId, buildCoverage } = require("./graph");

function* combinations(arr, k, start = 0, prefix = []) {
  if (k === 0) {
    yield prefix;
    return;
  }
  for (let i = start; i <= arr.length - k; i++) {
    yield* combinations(arr, k - 1, i + 1, [...prefix, arr[i]]);
  }
}

// Minimal explanation sets: the minimum-size subsets of changed params whose
// causal coverage covers every differing row. All tied minima are returned.
// Exact (exhaustive) while the number of changed params is small; a greedy
// fallback kicks in beyond 24 changed params and is flagged exact:false.
function minExplain(diff, snapA, snapB) {
  const changedParams = diff.params.changed.map((c) => c.path);
  const targets = new Set();
  for (const [table, r] of Object.entries(diff.tables)) {
    if (!r) continue;
    for (const k of r.only_a) targets.add(rowId(table, stableStringify(k)));
    for (const k of r.only_b) targets.add(rowId(table, stableStringify(k)));
    for (const ch of r.changed) targets.add(rowId(table, stableStringify(ch.key)));
  }
  const { coverage } = buildCoverage(snapA, snapB, changedParams);
  const coverable = new Set();
  for (const s of coverage.values()) for (const id of s) coverable.add(id);
  const goal = [...targets].filter((id) => coverable.has(id));
  const unexplained = [...targets].filter((id) => !coverable.has(id)).sort();

  const coversAll = (combo) => {
    const u = new Set();
    for (const p of combo) for (const id of coverage.get(p) || []) u.add(id);
    return goal.every((id) => u.has(id));
  };

  let explanations = [];
  let exact = true;
  if (changedParams.length <= 24) {
    let found = null;
    for (let k = 0; k <= changedParams.length && !found; k++) {
      const sols = [];
      for (const combo of combinations(changedParams, k)) {
        if (coversAll(combo)) sols.push(combo);
      }
      if (sols.length) found = sols;
    }
    explanations = found || [];
  } else {
    exact = false;
    const remaining = new Set(goal);
    const chosen = [];
    while (remaining.size) {
      let best = null;
      let bestGain = 0;
      for (const p of changedParams) {
        if (chosen.includes(p)) continue;
        let gain = 0;
        for (const id of coverage.get(p) || []) if (remaining.has(id)) gain++;
        if (gain > bestGain) {
          bestGain = gain;
          best = p;
        }
      }
      if (!best) break;
      chosen.push(best);
      for (const id of coverage.get(best)) remaining.delete(id);
    }
    explanations = chosen.length || goal.length === 0 ? [chosen] : [];
  }

  // The empty explanation set is only meaningful when there is nothing to
  // explain; if differing rows remain unexplained, report no explanation.
  if (targets.size > 0 && unexplained.length > 0 && explanations.length === 1 && explanations[0].length === 0) {
    explanations = [];
  }

  return {
    changedParams,
    targetRows: targets.size,
    explanations,
    explanationSize: explanations.length ? explanations[0].length : null,
    ambiguous: explanations.length > 1,
    unexplained,
    exact,
  };
}

module.exports = { minExplain, combinations };
