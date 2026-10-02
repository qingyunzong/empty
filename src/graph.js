// Deterministic graph helpers. All traversals iterate nodes and adjacency
// in sorted (lexicographic) order so results never depend on input order.

// Tarjan's SCC. `nodes` must be sorted; `adj` maps node -> sorted neighbors.
// Returns components (each sorted) sorted by their smallest node.
export function stronglyConnectedComponents(nodes, adj) {
  let counter = 0;
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const out = [];

  function visit(v) {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, minBig(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, minBig(low.get(v), index.get(w)));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      out.push(comp.sort());
    }
  }

  for (const v of nodes) {
    if (!index.has(v)) visit(v);
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function minBig(a, b) {
  return a < b ? a : b;
}

// Find one elementary cycle via three-color DFS over sorted nodes/adjacency.
// Returns cycle nodes in traversal order ([v0..vk] with edge vk -> v0), or null.
export function findCycle(nodes, adj) {
  const color = new Map(); // 1 = gray (on stack), 2 = black (done)
  const stack = [];

  function dfs(u) {
    color.set(u, 1);
    stack.push(u);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? 0;
      if (c === 0) {
        const r = dfs(v);
        if (r) return r;
      } else if (c === 1) {
        return stack.slice(stack.indexOf(v));
      }
    }
    stack.pop();
    color.set(u, 2);
    return null;
  }

  for (const n of nodes) {
    if (!color.get(n)) {
      const r = dfs(n);
      if (r) return r;
    }
  }
  return null;
}

// Rotate a cycle so its lexicographically smallest node comes first.
export function canonicalCycle(cycle) {
  let i = 0;
  for (let k = 1; k < cycle.length; k += 1) {
    if (cycle[k] < cycle[i]) i = k;
  }
  return cycle.slice(i).concat(cycle.slice(0, i));
}
