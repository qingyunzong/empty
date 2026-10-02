"use strict";

const { reworkInfo } = require("./decide");

const CONSTRAINTS = ["budget", "stockUseCap", "perProductStock"];

function collectReworkUsage(reworkIds, defectsById, policy) {
  let cost = 0;
  const perProduct = new Map();
  for (const id of reworkIds) {
    const defect = defectsById.get(id);
    if (!defect) continue;
    const info = reworkInfo(defect, policy);
    cost += info.reworkCost === null ? 0 : info.reworkCost;
    perProduct.set(defect.product, (perProduct.get(defect.product) || 0) + 1);
  }
  return { cost, perProduct, count: reworkIds.length };
}

function violatedConstraints(reworkIds, defectsById, policy, stock, skip = new Set()) {
  const { cost, perProduct, count } = collectReworkUsage(reworkIds, defectsById, policy);
  const violated = [];
  if (!skip.has("budget") && cost > policy.shiftBudget) violated.push("budget");
  if (!skip.has("stockUseCap") && count > policy.stockUseCap) violated.push("stockUseCap");
  if (!skip.has("perProductStock")) {
    for (const [product, used] of perProduct) {
      if (used > (stock[product] || 0)) {
        violated.push("perProductStock");
        break;
      }
    }
  }
  return violated;
}

function* combinations(items, size, start = 0, prefix = []) {
  if (prefix.length === size) {
    yield prefix;
    return;
  }
  for (let i = start; i < items.length; i++) {
    yield* combinations(items, size, i + 1, [...prefix, items[i]]);
  }
}

// Given a proposed (possibly invalid) rework plan, find the smallest sets of
// constraints whose absence would make the plan pass. This explains, for an
// over-budget counterexample, exactly which checks were minimally missing.
function minimalMissingConstraints(reworkIds, defectsById, policy, stock) {
  for (let size = 0; size <= CONSTRAINTS.length; size++) {
    const witnesses = [];
    for (const subset of combinations(CONSTRAINTS, size)) {
      if (violatedConstraints(reworkIds, defectsById, policy, stock, new Set(subset)).length === 0) {
        witnesses.push(subset);
      }
    }
    if (witnesses.length > 0) return witnesses;
  }
  return [];
}

module.exports = { CONSTRAINTS, violatedConstraints, minimalMissingConstraints };
