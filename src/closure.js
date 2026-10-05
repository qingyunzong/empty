'use strict';
// Derivation-closure computation. Two independent implementations are kept so
// tests can cross-check them by enumeration (n <= 8).

// BFS over parent edges with an optional step budget. Returns
// {set, exhausted}; exhausted=true means the budget ran out (PENDING).
function closureBFS(parents, start, budget = Infinity) {
  const set = new Set([start]);
  const queue = [start];
  let steps = 0;
  while (queue.length > 0) {
    const node = queue.shift();
    for (const p of parents.get(node) || []) {
      if (!set.has(p)) {
        steps += 1;
        if (steps > budget) return { set, exhausted: true };
        set.add(p);
        queue.push(p);
      }
    }
  }
  return { set, exhausted: false };
}

// Fixpoint iteration: repeatedly grow the ancestor set until stable.
function closureFixpoint(parents, start) {
  let set = new Set([start]);
  for (;;) {
    const next = new Set(set);
    for (const node of set) {
      for (const p of parents.get(node) || []) next.add(p);
    }
    if (next.size === set.size) return set;
    set = next;
  }
}

// Descendants (downstream) closure, used for revocation contagion display.
function descendants(children, start) {
  const set = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const node = queue.shift();
    for (const c of children.get(node) || []) {
      if (!set.has(c)) { set.add(c); queue.push(c); }
    }
  }
  return set;
}

// Shortest path from `from` down to `to` along children edges (for BROKEN cores).
function pathDown(children, from, to) {
  if (from === to) return [from];
  const prev = new Map([[from, null]]);
  const queue = [from];
  while (queue.length > 0) {
    const node = queue.shift();
    for (const c of children.get(node) || []) {
      if (!prev.has(c)) {
        prev.set(c, node);
        if (c === to) {
          const path = [c];
          let cur = node;
          while (cur !== null) { path.unshift(cur); cur = prev.get(cur); }
          return path;
        }
        queue.push(c);
      }
    }
  }
  return null;
}

module.exports = { closureBFS, closureFixpoint, descendants, pathDown };
