// Iterative Kosaraju strongly-connected-components.
// Deterministic: adjacency lists and start nodes are visited in ascending id order.

export function kosarajuScc(nodes, edges) {
  const adj = new Map();
  const radj = new Map();
  for (const node of nodes) {
    adj.set(node, []);
    radj.set(node, []);
  }
  for (const [from, to] of edges) {
    adj.get(from).push(to);
    radj.get(to).push(from);
  }
  for (const list of adj.values()) list.sort((a, b) => a - b);
  for (const list of radj.values()) list.sort((a, b) => a - b);

  const sortedNodes = [...nodes].sort((a, b) => a - b);
  const visited = new Set();
  const finishOrder = [];

  for (const start of sortedNodes) {
    if (visited.has(start)) continue;
    visited.add(start);
    const stack = [[start, 0]];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbors = adj.get(frame[0]);
      if (frame[1] < neighbors.length) {
        const next = neighbors[frame[1]];
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
  const sccs = [];
  for (let i = finishOrder.length - 1; i >= 0; i -= 1) {
    const start = finishOrder[i];
    if (assigned.has(start)) continue;
    assigned.add(start);
    const component = [];
    const stack = [start];
    while (stack.length > 0) {
      const node = stack.pop();
      component.push(node);
      for (const next of radj.get(node)) {
        if (!assigned.has(next)) {
          assigned.add(next);
          stack.push(next);
        }
      }
    }
    component.sort((a, b) => a - b);
    sccs.push(component);
  }
  return sccs;
}
