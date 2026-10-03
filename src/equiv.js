'use strict';

// Product-automaton BFS. A product state (qOld, qNew) is "bad" when the two
// machines assign different risk grades to it. Explores every product state
// reachable within m steps; the first bad state found at the shallowest depth
// yields the shortest distinguishing string (witness).
function compare(oldM, newM, m) {
  const alphabet = oldM.alphabet;
  const keyOf = (a, b) => JSON.stringify([a, b]);
  const visited = new Set([keyOf(oldM.start, newM.start)]);
  let frontier = [{ qOld: oldM.start, qNew: newM.start, path: [] }];
  const diff = new Set();
  let witness = null;
  for (let depth = 0; depth <= m && frontier.length > 0; depth += 1) {
    const next = [];
    for (const node of frontier) {
      if (oldM.risk[node.qOld] !== newM.risk[node.qNew]) {
        diff.add(node.qOld);
        if (witness === null) witness = node.path;
      }
      if (depth === m) continue;
      for (const symbol of alphabet) {
        const toOld = oldM.transitions[node.qOld][symbol];
        const toNew = newM.transitions[node.qNew][symbol];
        const key = keyOf(toOld, toNew);
        if (!visited.has(key)) {
          visited.add(key);
          next.push({ qOld: toOld, qNew: toNew, path: node.path.concat([symbol]) });
        }
      }
    }
    frontier = next;
  }
  return { equal: diff.size === 0, witness, diffStates: [...diff].sort() };
}

module.exports = { compare };
