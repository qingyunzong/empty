const byNumber = (a, b) => a - b;

function buildAdjacency(nodes, edges, reverse) {
  const adj = new Map();
  for (const node of nodes) adj.set(node, []);
  for (const [u, v] of edges) {
    if (!adj.has(u)) adj.set(u, []);
    if (!adj.has(v)) adj.set(v, []);
    if (reverse) adj.get(v).push(u);
    else adj.get(u).push(v);
  }
  for (const list of adj.values()) list.sort(byNumber);
  return adj;
}

export function kosaraju(nodes, edges) {
  const adj = buildAdjacency(nodes, edges, false);
  const rev = buildAdjacency(nodes, edges, true);
  const all = [...adj.keys()].sort(byNumber);

  const visited = new Set();
  const finishOrder = [];
  for (const start of all) {
    if (visited.has(start)) continue;
    visited.add(start);
    const stack = [[start, 0]];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbours = adj.get(frame[0]);
      if (frame[1] < neighbours.length) {
        const next = neighbours[frame[1]];
        frame[1] += 1;
        if (!visited.has(next)) {
          visited.add(next);
          stack.push([next, 0]);
        }
      } else {
        finishOrder.push(frame[0]);
        stack.pop();
      }
    }
  }

  const assigned = new Set();
  const components = [];
  for (let i = finishOrder.length - 1; i >= 0; i -= 1) {
    const start = finishOrder[i];
    if (assigned.has(start)) continue;
    assigned.add(start);
    const component = [];
    const stack = [start];
    while (stack.length > 0) {
      const node = stack.pop();
      component.push(node);
      for (const next of rev.get(node)) {
        if (!assigned.has(next)) {
          assigned.add(next);
          stack.push(next);
        }
      }
    }
    component.sort(byNumber);
    components.push(component);
  }
  return components;
}

export function condensation(nodes, edges, components) {
  const componentOf = new Map();
  components.forEach((component, index) => {
    for (const node of component) componentOf.set(node, index);
  });

  const dag = components.map(() => new Set());
  for (const [u, v] of edges) {
    const from = componentOf.get(u);
    const to = componentOf.get(v);
    if (from !== to) dag[from].add(to);
  }

  const indegree = components.map(() => 0);
  dag.forEach((targets) => {
    for (const target of targets) indegree[target] += 1;
  });

  const rank = (index) => components[index][0];
  const ready = [];
  for (let i = 0; i < components.length; i += 1) {
    if (indegree[i] === 0) ready.push(i);
  }
  ready.sort((a, b) => rank(a) - rank(b));

  const topo = [];
  while (ready.length > 0) {
    const current = ready.shift();
    topo.push(current);
    for (const next of [...dag[current]].sort((a, b) => rank(a) - rank(b))) {
      indegree[next] -= 1;
      if (indegree[next] === 0) {
        ready.push(next);
        ready.sort((a, b) => rank(a) - rank(b));
      }
    }
  }

  return {
    dag: dag.map((targets) => [...targets].sort((a, b) => rank(a) - rank(b))),
    topo,
  };
}

export function bfsPath(adj, start, goal) {
  if (start === goal) return [start];
  const previous = new Map([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const node = queue.shift();
    for (const next of adj.get(node) ?? []) {
      if (previous.has(next)) continue;
      previous.set(next, node);
      if (next === goal) {
        const path = [goal];
        let cursor = node;
        while (cursor !== null) {
          path.unshift(cursor);
          cursor = previous.get(cursor);
        }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

export function bruteForceComponents(nodes, edges) {
  const adj = buildAdjacency(nodes, edges, false);
  const all = [...adj.keys()].sort(byNumber);
  const reachable = new Map();
  for (const node of all) {
    const seen = new Set([node]);
    const queue = [node];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const next of adj.get(current)) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    reachable.set(node, seen);
  }

  const grouped = new Set();
  const components = [];
  for (const node of all) {
    if (grouped.has(node)) continue;
    const component = all.filter(
      (other) => reachable.get(node).has(other) && reachable.get(other).has(node),
    );
    for (const member of component) grouped.add(member);
    components.push(component);
  }
  return components;
}
