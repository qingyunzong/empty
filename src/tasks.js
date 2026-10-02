export function buildTasks(oldDfa, newDfa, divergentPairs) {
  const coverMap = new Map();
  divergentPairs.forEach(([oldState, newState], pairIndex) => {
    for (const id of [`old:${oldState}`, `new:${newState}`]) {
      if (!coverMap.has(id)) {
        coverMap.set(id, []);
      }
      coverMap.get(id).push(pairIndex);
    }
  });
  const tasks = [];
  for (const [id, covers] of coverMap) {
    const state = id.slice(4);
    const dfa = id.startsWith("old:") ? oldDfa : newDfa;
    const cost = dfa.costs[state] !== undefined ? dfa.costs[state] : 1;
    tasks.push({ id, cost, covers: [...covers].sort((a, b) => a - b) });
  }
  tasks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return tasks;
}

function lexLess(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) {
      return a[i] < b[i];
    }
  }
  return a.length < b.length;
}

function lowestBitIndex(mask) {
  let index = 0;
  let rest = mask;
  while ((rest & 1n) === 0n) {
    rest >>= 1n;
    index += 1;
  }
  return index;
}

export function minCostCover(tasks, pairCount) {
  if (pairCount === 0) {
    return { cost: 0, ids: [] };
  }
  const sorted = [...tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const masks = sorted.map((task) =>
    task.covers.reduce((mask, pairIndex) => mask | (1n << BigInt(pairIndex)), 0n)
  );
  const byPair = Array.from({ length: pairCount }, () => []);
  sorted.forEach((task, taskIndex) => {
    for (const pairIndex of task.covers) {
      byPair[pairIndex].push(taskIndex);
    }
  });
  const full = (1n << BigInt(pairCount)) - 1n;
  const used = new Array(sorted.length).fill(false);
  const chosen = [];
  let best = null;

  function dfs(uncovered, cost) {
    if (uncovered === 0n) {
      const ids = chosen.map((i) => sorted[i].id).sort();
      if (best === null || cost < best.cost || (cost === best.cost && lexLess(ids, best.ids))) {
        best = { cost, ids };
      }
      return;
    }
    if (best !== null && cost > best.cost) {
      return;
    }
    const pairIndex = lowestBitIndex(uncovered);
    for (const taskIndex of byPair[pairIndex]) {
      if (used[taskIndex]) {
        continue;
      }
      used[taskIndex] = true;
      chosen.push(taskIndex);
      dfs(uncovered & ~masks[taskIndex], cost + sorted[taskIndex].cost);
      chosen.pop();
      used[taskIndex] = false;
    }
  }

  dfs(full, 0);
  return best;
}
