// Directed graph SCC algorithms. Tarjan is the primary algorithm;
// Kosaraju is an independent implementation used as a cross-check.

export function tarjanScc(nodes, edges) {
  const adj = new Map();
  for (const n of nodes) adj.set(n, []);
  for (const [u, v] of edges) adj.get(u).push(v);

  const indexOf = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let counter = 0;

  function strongconnect(v) {
    indexOf.set(v, counter);
    lowlink.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v)) {
      if (!indexOf.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), indexOf.get(w)));
      }
    }
    if (lowlink.get(v) === indexOf.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      components.push(comp);
    }
  }

  for (const v of [...adj.keys()].sort()) {
    if (!indexOf.has(v)) strongconnect(v);
  }
  return components;
}

// Independent SCC implementation (Kosaraju, two DFS passes) used only
// to cross-check Tarjan results on small graphs (n <= 7).
export function kosarajuScc(nodes, edges) {
  const adj = new Map();
  const radj = new Map();
  for (const n of nodes) {
    adj.set(n, []);
    radj.set(n, []);
  }
  for (const [u, v] of edges) {
    adj.get(u).push(v);
    radj.get(v).push(u);
  }

  const visited = new Set();
  const order = [];
  function dfs1(v) {
    visited.add(v);
    for (const w of adj.get(v)) if (!visited.has(w)) dfs1(w);
    order.push(v);
  }
  for (const v of [...adj.keys()].sort()) {
    if (!visited.has(v)) dfs1(v);
  }

  const components = [];
  const assigned = new Set();
  function dfs2(v, comp) {
    assigned.add(v);
    comp.push(v);
    for (const w of radj.get(v)) if (!assigned.has(w)) dfs2(w, comp);
  }
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const v = order[i];
    if (!assigned.has(v)) {
      const comp = [];
      dfs2(v, comp);
      components.push(comp);
    }
  }
  return components;
}

// Canonical form: each component sorted, components sorted lexicographically.
export function canonicalComponents(components) {
  return components
    .map((comp) => [...comp].sort())
    .sort((a, b) => {
      const sa = JSON.stringify(a);
      const sb = JSON.stringify(b);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
}

export function componentsEqual(a, b) {
  return JSON.stringify(canonicalComponents(a)) === JSON.stringify(canonicalComponents(b));
}
