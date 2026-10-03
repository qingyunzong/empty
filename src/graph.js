'use strict';

// Directed graph helpers. Edges are [child, parent] pairs: child -> parent.

function buildAdjacency(edges) {
  const adj = new Map();
  const ensure = (node) => {
    if (!adj.has(node)) adj.set(node, new Set());
    return adj.get(node);
  };
  for (const [child, parent] of edges) {
    ensure(child).add(parent);
    ensure(parent);
  }
  return adj;
}

function reverseAdjacency(adj) {
  const rev = new Map();
  const ensure = (node) => {
    if (!rev.has(node)) rev.set(node, new Set());
    return rev.get(node);
  };
  for (const [node, targets] of adj) {
    ensure(node);
    for (const target of targets) ensure(target).add(node);
  }
  return rev;
}

// Reference algorithm: independently enumerate every node reachable from
// `start` in the directed graph described by `adj` (BFS, includes `start`).
function reachable(adj, start) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const node = queue.shift();
    const targets = adj.get(node);
    if (!targets) continue;
    for (const next of targets) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

// Returns a cycle as an array of nodes if one exists, otherwise null.
function findCycle(adj) {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  for (const node of adj.keys()) color.set(node, WHITE);

  const stack = [];
  for (const root of adj.keys()) {
    if (color.get(root) !== WHITE) continue;
    const frames = [{ node: root, iter: (adj.get(root) || new Set())[Symbol.iterator]() }];
    color.set(root, GRAY);
    stack.push(root);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const step = frame.iter.next();
      if (step.done) {
        color.set(frame.node, BLACK);
        stack.pop();
        frames.pop();
        continue;
      }
      const next = step.value;
      const nextColor = color.get(next) ?? WHITE;
      if (nextColor === GRAY) {
        const idx = stack.indexOf(next);
        return stack.slice(idx).concat(next);
      }
      if (nextColor === WHITE) {
        color.set(next, GRAY);
        stack.push(next);
        frames.push({ node: next, iter: (adj.get(next) || new Set())[Symbol.iterator]() });
      }
    }
  }
  return null;
}

module.exports = { buildAdjacency, reverseAdjacency, reachable, findCycle };
