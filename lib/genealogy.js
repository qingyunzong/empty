'use strict';

const crypto = require('node:crypto');

const KEY_SEP = ' ';

class GraphFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GraphFormatError';
  }
}

function edgeKey(child, parent) {
  return `${child}${KEY_SEP}${parent}`;
}

function splitKey(key) {
  const idx = key.indexOf(KEY_SEP);
  return [key.slice(0, idx), key.slice(idx + 1)];
}

function fail(message) {
  throw new GraphFormatError(message);
}

// Validates a raw parsed-JSON graph and returns the normalized internal form:
// { lots: Set<string>, edges: Map<key, relation> } where key = child + ' ' + parent.
// Input graphs must be well-formed DAGs: valid shapes, existing references,
// no self-loops, no duplicate edges, no directed cycles.
function normalizeGraph(raw, label = 'graph') {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`${label}: expected an object with "lots" and "edges"`);
  }
  const { lots, edges } = raw;
  if (!Array.isArray(lots)) fail(`${label}: "lots" must be an array`);
  const lotSet = new Set();
  for (const lot of lots) {
    if (typeof lot !== 'string' || lot.length === 0) {
      fail(`${label}: lot ids must be non-empty strings`);
    }
    if (lot.includes(KEY_SEP)) fail(`${label}: lot id ${JSON.stringify(lot)} contains a forbidden character`);
    if (lotSet.has(lot)) fail(`${label}: duplicate lot ${JSON.stringify(lot)}`);
    lotSet.add(lot);
  }
  if (!Array.isArray(edges)) fail(`${label}: "edges" must be an array`);
  const edgeMap = new Map();
  for (const edge of edges) {
    if (edge === null || typeof edge !== 'object' || Array.isArray(edge)) {
      fail(`${label}: each edge must be an object {child, parent, relation}`);
    }
    const { child, parent, relation } = edge;
    for (const [field, value] of [['child', child], ['parent', parent], ['relation', relation]]) {
      if (typeof value !== 'string' || value.length === 0) {
        fail(`${label}: edge ${field} must be a non-empty string`);
      }
    }
    if (child === parent) fail(`${label}: self-loop on lot ${JSON.stringify(child)}`);
    if (!lotSet.has(child)) fail(`${label}: edge references unknown lot ${JSON.stringify(child)}`);
    if (!lotSet.has(parent)) fail(`${label}: edge references unknown lot ${JSON.stringify(parent)}`);
    const key = edgeKey(child, parent);
    if (edgeMap.has(key)) fail(`${label}: duplicate edge ${JSON.stringify(child)} -> ${JSON.stringify(parent)}`);
    edgeMap.set(key, relation);
  }
  const graph = { lots: lotSet, edges: edgeMap };
  const cycle = findCycle(graph);
  if (cycle) fail(`${label}: input graph contains a directed cycle: ${cycle.join(' -> ')}`);
  return graph;
}

function buildAdjacency(graph) {
  const adj = new Map();
  for (const lot of graph.lots) adj.set(lot, []);
  for (const key of graph.edges.keys()) {
    const [child, parent] = splitKey(key);
    adj.get(child).push(parent);
  }
  return adj;
}

// Iterative DFS (edges point child -> parent). Returns one cycle as a list of
// lot ids ending where it closes, or null when the graph is acyclic.
function findCycle(graph) {
  const adj = buildAdjacency(graph);
  const state = new Map(); // 0 = unvisited, 1 = on stack, 2 = done
  for (const lot of graph.lots) state.set(lot, 0);
  for (const root of graph.lots) {
    if (state.get(root) !== 0) continue;
    const stack = [root];
    const iterators = [adj.get(root)[Symbol.iterator]()];
    state.set(root, 1);
    while (stack.length > 0) {
      const next = iterators[iterators.length - 1].next();
      if (next.done) {
        state.set(stack.pop(), 2);
        iterators.pop();
        continue;
      }
      const node = next.value;
      const s = state.get(node);
      if (s === 0) {
        state.set(node, 1);
        stack.push(node);
        iterators.push(adj.get(node)[Symbol.iterator]());
      } else if (s === 1) {
        const idx = stack.indexOf(node);
        return stack.slice(idx).concat(node);
      }
    }
  }
  return null;
}

function isDag(graph) {
  return findCycle(graph) === null;
}

// All lots reachable from `src` following child -> parent edges (excluding src).
function reachable(graph, src) {
  const adj = buildAdjacency(graph);
  const seen = new Set();
  const stack = [...(adj.get(src) || [])];
  while (stack.length > 0) {
    const node = stack.pop();
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of adj.get(node) || []) stack.push(next);
  }
  return seen;
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Canonical plain form: sorted lots, sorted edges. Used for output and hashing.
function toPlain(graph) {
  const lots = [...graph.lots].sort();
  const edges = [...graph.edges.entries()]
    .map(([key, relation]) => {
      const [child, parent] = splitKey(key);
      return { child, parent, relation };
    })
    .sort((a, b) => compareStrings(a.child, b.child) || compareStrings(a.parent, b.parent));
  return { lots, edges };
}

function hashGraph(graph) {
  return crypto.createHash('sha256').update(JSON.stringify(toPlain(graph))).digest('hex');
}

// Three-way merge of normalized graphs. Edge identity is (child, parent);
// `relation` is a merged attribute. Decision table per edge (b/l/r = relation
// or null when absent):
//   l === r            -> take it (both sides agree, incl. identical add/remove)
//   b === l            -> take r (only remote changed)
//   b === r            -> take l (only local changed)
//   otherwise          -> conflict (delete vs modify, add vs delete,
//                         relation changed to two different values)
// Nodes are merged with the same three-way set rule (no attribute, so they
// cannot conflict by themselves). Post-merge structural validation flags
// dangling references, self-loops and directed cycles as conflicts.
function mergeGraphs(base, local, remote) {
  const conflicts = [];

  const lots = new Set();
  const allLots = new Set([...base.lots, ...local.lots, ...remote.lots]);
  for (const lot of allLots) {
    const b = base.lots.has(lot);
    const l = local.lots.has(lot);
    const r = remote.lots.has(lot);
    const keep = l === r ? l : b === l ? r : l;
    if (keep) lots.add(lot);
  }

  const edges = new Map();
  const allKeys = new Set([...base.edges.keys(), ...local.edges.keys(), ...remote.edges.keys()]);
  for (const key of allKeys) {
    const b = base.edges.has(key) ? base.edges.get(key) : null;
    const l = local.edges.has(key) ? local.edges.get(key) : null;
    const r = remote.edges.has(key) ? remote.edges.get(key) : null;
    let take;
    if (l === r) {
      take = l;
    } else if (b === l) {
      take = r;
    } else if (b === r) {
      take = l;
    } else {
      const [child, parent] = splitKey(key);
      conflicts.push({ type: 'edge', child, parent, base: b, local: l, remote: r });
      take = b; // best-effort merged output keeps the base state
    }
    if (take !== null) edges.set(key, take);
  }

  for (const [key, relation] of [...edges.entries()]) {
    const [child, parent] = splitKey(key);
    const missing = [];
    if (!lots.has(child)) missing.push(child);
    if (!lots.has(parent)) missing.push(parent);
    if (missing.length > 0) {
      conflicts.push({ type: 'dangling', child, parent, relation, missing });
      edges.delete(key);
    }
    if (child === parent) {
      conflicts.push({ type: 'self-loop', child, parent, relation });
      edges.delete(key);
    }
  }

  const merged = { lots, edges };
  const cycle = findCycle(merged);
  if (cycle) conflicts.push({ type: 'cycle', path: cycle });

  return { merged: toPlain(merged), conflicts, baseHash: hashGraph(base) };
}

module.exports = {
  GraphFormatError,
  normalizeGraph,
  mergeGraphs,
  findCycle,
  isDag,
  reachable,
  toPlain,
  hashGraph,
};
