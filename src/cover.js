'use strict';

// Exact minimum-cost cover of the difference states by manual-confirmation
// tasks. Enumerates task subsets (DFS with cost pruning), so it is exact and
// fully deterministic. Ordering of "best": lower total cost, then fewer
// tasks, then lexicographically smaller sorted id list.
function minCover(diffStates, tasks) {
  const need = new Set(diffStates);
  if (need.size === 0) return { tasks: [], cost: 0 };
  const sorted = [...tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let best = null;
  const chosen = [];
  const covered = new Set();

  const isBetter = (ids, cost) => {
    if (best === null) return true;
    if (cost !== best.cost) return cost < best.cost;
    if (ids.length !== best.ids.length) return ids.length < best.ids.length;
    return JSON.stringify(ids) < JSON.stringify(best.ids);
  };

  const dfs = (index, cost) => {
    if (best !== null && cost > best.cost) return;
    if (index === sorted.length) {
      for (const state of need) {
        if (!covered.has(state)) return;
      }
      const ids = chosen.map((t) => t.id).sort();
      if (isBetter(ids, cost)) best = { ids, cost };
      return;
    }
    dfs(index + 1, cost);
    const task = sorted[index];
    const added = [];
    for (const state of task.covers) {
      if (!covered.has(state)) {
        covered.add(state);
        added.push(state);
      }
    }
    chosen.push(task);
    dfs(index + 1, cost + task.cost);
    chosen.pop();
    for (const state of added) covered.delete(state);
  };

  dfs(0, 0);
  return best === null ? null : { tasks: best.ids, cost: best.cost };
}

module.exports = { minCover };
