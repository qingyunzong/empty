'use strict';

// Role inheritance graph. Edge role -> parent means "role inherits parent".
// The graph must remain a DAG; cycle detection happens at edge insertion
// time in policy.js via reaches().

// Returns true if `target` is reachable from `from` following inherit edges
// (zero hops counts: from === target is reachable).
function reaches(adj, from, target) {
  if (from === target) return true;
  const seen = new Set([from]);
  const stack = [from];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const next of adj.get(cur) || []) {
      if (next === target) return true;
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

// BFS from `start` over inherit edges. Returns a Map of role ->
// { distance, path } where distance is the shortest hop count (0 for the
// start role itself) and path is the inheritance chain from start to that
// role. Neighbours are visited in sorted order so the recorded path is
// deterministic when several shortest paths exist.
function ancestorsWithDistance(adj, start) {
  const result = new Map([[start, { distance: 0, path: [start] }]]);
  const queue = [start];
  while (queue.length > 0) {
    const cur = queue.shift();
    const info = result.get(cur);
    const parents = [...(adj.get(cur) || [])].sort();
    for (const parent of parents) {
      if (!result.has(parent)) {
        result.set(parent, {
          distance: info.distance + 1,
          path: [...info.path, parent],
        });
        queue.push(parent);
      }
    }
  }
  return result;
}

module.exports = { reaches, ancestorsWithDistance };
