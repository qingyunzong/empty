'use strict';

// Backtracking batch placement for one cancellation request.
//
// orderedStages: pending stages in children-first order.
// batches: [{ id, domains:Set, quotas:Map(account->limit) }] (candidate order = array order).
// remaining: Map(batchId -> Map(account -> amount left)); not mutated.
// compensated: Set of stage ids already compensated by earlier requests.
//
// Returns { placements: Map(stageId -> batchId), count } maximizing the number of
// placed stages. A stage may be placed only when every child stage is already
// compensated or placed earlier in this search (children compensate before parents).
function solvePlacement(orderedStages, batches, remaining, compensated) {
  const remainingCopy = batches.map((batch) => new Map(remaining.get(batch.id)));
  const current = new Map();
  let best = null;
  let bestCount = -1;

  function childrenSatisfied(stage) {
    for (const childId of stage.children) {
      if (!compensated.has(childId) && !current.has(childId)) return false;
    }
    return true;
  }

  function dfs(index) {
    if (bestCount === orderedStages.length) return;
    if (current.size + (orderedStages.length - index) <= bestCount) return;
    if (index === orderedStages.length) {
      bestCount = current.size;
      best = new Map(current);
      return;
    }
    const stage = orderedStages[index];
    if (childrenSatisfied(stage)) {
      for (let bi = 0; bi < batches.length; bi += 1) {
        const batch = batches[bi];
        if (!batch.domains.has(stage.type)) continue;
        const left = remainingCopy[bi].get(stage.account) || 0;
        if (left < stage.amount) continue;
        remainingCopy[bi].set(stage.account, left - stage.amount);
        current.set(stage.id, batch.id);
        dfs(index + 1);
        current.delete(stage.id);
        remainingCopy[bi].set(stage.account, left);
      }
    }
    dfs(index + 1);
  }

  dfs(0);
  return { placements: best || new Map(), count: Math.max(bestCount, 0) };
}

// Reference implementation: brute-force enumeration of every batch assignment
// (including "skip") for small stage counts (<= 4). Used to cross-check the solver.
function enumeratePlacements(orderedStages, batches, remaining, compensated) {
  const options = [null, ...batches.map((batch) => batch.id)];
  let bestCount = -1;
  const choice = new Array(orderedStages.length).fill(null);

  function visit(index, quotaLeft) {
    if (index === orderedStages.length) {
      let count = 0;
      const placed = new Set();
      for (let i = 0; i < orderedStages.length; i += 1) {
        if (choice[i] !== null) placed.add(orderedStages[i].id);
      }
      for (let i = 0; i < orderedStages.length; i += 1) {
        if (choice[i] === null) continue;
        const ok = orderedStages[i].children.every(
          (childId) => compensated.has(childId) || placed.has(childId)
        );
        if (!ok) return;
        count += 1;
      }
      if (count > bestCount) bestCount = count;
      return;
    }
    for (const option of options) {
      if (option !== null) {
        const bi = batches.findIndex((batch) => batch.id === option);
        const stage = orderedStages[index];
        if (!batches[bi].domains.has(stage.type)) continue;
        const left = quotaLeft[bi].get(stage.account) || 0;
        if (left < stage.amount) continue;
        quotaLeft[bi].set(stage.account, left - stage.amount);
        choice[index] = option;
        visit(index + 1, quotaLeft);
        quotaLeft[bi].set(stage.account, left);
      } else {
        choice[index] = null;
        visit(index + 1, quotaLeft);
      }
    }
    choice[index] = null;
  }

  visit(0, batches.map((batch) => new Map(remaining.get(batch.id))));
  return bestCount;
}

module.exports = { solvePlacement, enumeratePlacements };
