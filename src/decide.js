"use strict";

const { ExitError } = require("./errors");

const EXACT_ENUMERATION_LIMIT = 20;

function resolveLevel(defect, policy) {
  if (defect.level) return defect.level;
  const category = policy.categories[defect.product];
  if (!category || typeof category.level !== "string") {
    throw new ExitError(
      `defect ${defect.id}: no explicit level and no category level for product ${defect.product}`,
      1
    );
  }
  return category.level;
}

function reworkInfo(defect, policy) {
  const level = resolveLevel(defect, policy);
  const category = policy.categories[defect.product] || {};
  const reworkCost =
    typeof defect.reworkCost === "number"
      ? defect.reworkCost
      : typeof category.reworkCost === "number"
        ? category.reworkCost
        : null;
  const reworkable = policy.reworkableLevels.includes(level) && reworkCost !== null;
  const savings = reworkable ? defect.amount - reworkCost : 0;
  return { level, reworkCost, reworkable, savings };
}

// Concession vs scrap conflict resolution:
//   1. customer blacklist has highest priority -> scrap
//   2. amount threshold: below -> concession, above -> scrap
//   3. exactly at threshold is a tie -> reject the concession -> scrap
function resolveConcessionOrScrap(defect, policy) {
  if (policy.blacklist.includes(defect.customer)) {
    return { action: "scrap", rule: "blacklist" };
  }
  if (defect.amount < policy.concessionThreshold) {
    return { action: "concession", rule: "below-threshold" };
  }
  if (defect.amount > policy.concessionThreshold) {
    return { action: "scrap", rule: "above-threshold" };
  }
  return { action: "scrap", rule: "tie-reject" };
}

function compareIdLists(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

function isFeasible(selection, candidates, limits) {
  let cost = 0;
  const perProduct = new Map();
  for (const idx of selection) {
    const candidate = candidates[idx];
    cost += candidate.reworkCost;
    if (cost > limits.budget) return false;
    const used = (perProduct.get(candidate.product) || 0) + 1;
    if (used > (limits.stock[candidate.product] || 0)) return false;
    perProduct.set(candidate.product, used);
  }
  return selection.length <= limits.stockUseCap;
}

function evaluate(selection, candidates) {
  let savings = 0;
  let cost = 0;
  const ids = [];
  for (const idx of selection) {
    savings += candidates[idx].savings;
    cost += candidates[idx].reworkCost;
    ids.push(candidates[idx].id);
  }
  ids.sort();
  return { selection: selection.slice(), savings, cost, ids };
}

// Deterministic plan ordering: maximize savings, then minimize cost,
// then lexicographically smallest sorted id list (stable tie-break).
function betterPlan(a, b) {
  if (a.savings !== b.savings) return a.savings > b.savings;
  if (a.cost !== b.cost) return a.cost < b.cost;
  return compareIdLists(a.ids, b.ids) < 0;
}

function selectReworkEnumerate(candidates, limits) {
  const n = candidates.length;
  let best = evaluate([], candidates);
  const total = 2 ** n;
  for (let mask = 1; mask < total; mask++) {
    const selection = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) selection.push(i);
    }
    if (!isFeasible(selection, candidates, limits)) continue;
    const plan = evaluate(selection, candidates);
    if (betterPlan(plan, best)) best = plan;
  }
  return best;
}

function selectReworkNaive(candidates, limits) {
  let best = evaluate([], candidates);
  const selection = [];
  function dfs(i) {
    if (i === candidates.length) {
      if (isFeasible(selection, candidates, limits)) {
        const plan = evaluate(selection, candidates);
        if (betterPlan(plan, best)) best = plan;
      }
      return;
    }
    dfs(i + 1);
    selection.push(i);
    dfs(i + 1);
    selection.pop();
  }
  dfs(0);
  return best;
}

function selectReworkGreedy(candidates, limits) {
  const order = candidates.map((_, i) => i).sort((a, b) => {
    const ca = candidates[a];
    const cb = candidates[b];
    const ra = ca.savings / ca.reworkCost;
    const rb = cb.savings / cb.reworkCost;
    if (ra !== rb) return rb - ra;
    if (ca.savings !== cb.savings) return cb.savings - ca.savings;
    return ca.id < cb.id ? -1 : ca.id > cb.id ? 1 : 0;
  });
  const selection = [];
  for (const i of order) {
    selection.push(i);
    if (!isFeasible(selection, candidates, limits)) selection.pop();
  }
  return evaluate(selection, candidates);
}

function selectRework(candidates, limits) {
  if (candidates.length <= EXACT_ENUMERATION_LIMIT) {
    return selectReworkEnumerate(candidates, limits);
  }
  return selectReworkGreedy(candidates, limits);
}

function decideAll(defects, policy, stock) {
  const infos = new Map();
  const candidates = [];
  for (const defect of defects) {
    const info = reworkInfo(defect, policy);
    infos.set(defect.id, info);
    if (info.reworkable && info.savings > 0) {
      candidates.push({
        id: defect.id,
        product: defect.product,
        reworkCost: info.reworkCost,
        savings: info.savings,
      });
    }
  }
  candidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const limits = { budget: policy.shiftBudget, stockUseCap: policy.stockUseCap, stock };
  const plan = selectRework(candidates, limits);
  const chosen = new Set(plan.ids);

  const decisions = new Map();
  for (const defect of defects) {
    const info = infos.get(defect.id);
    if (chosen.has(defect.id)) {
      decisions.set(defect.id, {
        id: defect.id,
        product: defect.product,
        customer: defect.customer,
        level: info.level,
        action: "rework",
        rule: "rework-optimal",
        reworkCost: info.reworkCost,
        savings: info.savings,
      });
    } else {
      const { action, rule } = resolveConcessionOrScrap(defect, policy);
      decisions.set(defect.id, {
        id: defect.id,
        product: defect.product,
        customer: defect.customer,
        level: info.level,
        action,
        rule,
      });
    }
  }
  return decisions;
}

module.exports = {
  EXACT_ENUMERATION_LIMIT,
  resolveLevel,
  reworkInfo,
  resolveConcessionOrScrap,
  isFeasible,
  evaluate,
  betterPlan,
  selectRework,
  selectReworkEnumerate,
  selectReworkNaive,
  selectReworkGreedy,
  decideAll,
};
