import { createHash } from 'node:crypto';

export const DEFAULT_MAX_STEPS = 10_000_000;

export class ProveTimeoutError extends Error {
  constructor(message = 'proof search exceeded step budget') {
    super(message);
    this.name = 'ProveTimeoutError';
    this.code = 'PROVE_TIMEOUT';
  }
}

export class NoSuchNodeError extends Error {
  constructor(node) {
    super(`no such node: ${JSON.stringify(node)}`);
    this.name = 'NoSuchNodeError';
    this.code = 'NO_SUCH_NODE';
    this.node = node;
  }
}

export class NoPathError extends Error {
  constructor(s, t) {
    super(`no path from ${JSON.stringify(s)} to ${JSON.stringify(t)}`);
    this.name = 'NoPathError';
    this.code = 'NO_PATH';
  }
}

export class PathExistsError extends Error {
  constructor(s, t) {
    super(`a path from ${JSON.stringify(s)} to ${JSON.stringify(t)} exists; cannot prove non-reachability`);
    this.name = 'PathExistsError';
    this.code = 'PATH_EXISTS';
  }
}

export function sha256hex(data) {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

export function canonEdge(edge) {
  return JSON.stringify([edge[0], edge[1]]);
}

function compareStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function normalizeNodes(nodes) {
  if (!Array.isArray(nodes)) throw new TypeError('nodes must be an array');
  const out = [...new Set(nodes.map(String))].sort(compareStr);
  return out;
}

export function normalizeEdges(edges) {
  if (!Array.isArray(edges)) throw new TypeError('edges must be an array');
  const seen = new Set();
  const out = [];
  for (const e of edges) {
    if (!Array.isArray(e) || e.length !== 2) {
      throw new TypeError(`edge must be a [from, to] pair, got: ${JSON.stringify(e)}`);
    }
    const edge = [String(e[0]), String(e[1])];
    const key = canonEdge(edge);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(edge);
    }
  }
  out.sort((a, b) => compareStr(canonEdge(a), canonEdge(b)));
  return out;
}

/**
 * Build a versioned, immutable graph snapshot.
 * The version is a SHA-256 commitment over the canonical node/edge sets;
 * every certificate is bound to it.
 */
export function buildGraph(nodes, edges) {
  const sortedNodes = normalizeNodes(nodes);
  const sortedEdges = normalizeEdges(edges);
  const nodeSet = new Set(sortedNodes);
  for (const [u, v] of sortedEdges) {
    if (!nodeSet.has(u)) throw new NoSuchNodeError(u);
    if (!nodeSet.has(v)) throw new NoSuchNodeError(v);
  }
  const version = sha256hex(
    'graph-v1\n' + JSON.stringify(sortedNodes) + '\n' + JSON.stringify(sortedEdges.map(canonEdge))
  );
  const adjacency = new Map();
  for (const n of sortedNodes) adjacency.set(n, []);
  for (const [u, v] of sortedEdges) adjacency.get(u).push(v);
  for (const list of adjacency.values()) list.sort(compareStr);

  return Object.freeze({
    nodes: sortedNodes,
    edges: sortedEdges,
    nodeSet,
    adjacency,
    version,
  });
}

function spendSteps(budget, amount = 1) {
  budget.remaining -= amount;
  if (budget.remaining < 0) throw new ProveTimeoutError();
}

/**
 * BFS reachable set from source. Deterministic (sorted adjacency).
 * Throws ProveTimeoutError when the step budget is exhausted — callers must
 * never report that as NO_PATH.
 */
export function reachableSet(graph, source, maxSteps = DEFAULT_MAX_STEPS) {
  if (!graph.nodeSet.has(source)) throw new NoSuchNodeError(source);
  const budget = { remaining: maxSteps };
  const seen = new Set([source]);
  const queue = [source];
  for (let head = 0; head < queue.length; head++) {
    spendSteps(budget);
    const u = queue[head];
    for (const v of graph.adjacency.get(u)) {
      spendSteps(budget);
      if (!seen.has(v)) {
        seen.add(v);
        queue.push(v);
      }
    }
  }
  return seen;
}

/**
 * Deterministic shortest path (fewest edges, lexicographic tie-break via
 * sorted adjacency and FIFO BFS). Returns array of nodes, or null.
 */
export function shortestPath(graph, s, t, maxSteps = DEFAULT_MAX_STEPS) {
  if (!graph.nodeSet.has(s)) throw new NoSuchNodeError(s);
  if (!graph.nodeSet.has(t)) throw new NoSuchNodeError(t);
  const budget = { remaining: maxSteps };
  const parent = new Map([[s, null]]);
  const queue = [s];
  for (let head = 0; head < queue.length; head++) {
    spendSteps(budget);
    const u = queue[head];
    if (u === t) break;
    for (const v of graph.adjacency.get(u)) {
      spendSteps(budget);
      if (!parent.has(v)) {
        parent.set(v, u);
        queue.push(v);
      }
    }
  }
  if (!parent.has(t)) return null;
  const path = [];
  for (let cur = t; cur !== null; cur = parent.get(cur)) path.push(cur);
  path.reverse();
  return path;
}

/**
 * Boundary edges of a set R: every graph edge whose source is in R.
 * Closure check for non-reachability: each such edge's target must also be
 * in R. The full list is committed into the certificate so a missing layer
 * (deleted boundary edge) is detectable.
 */
export function boundaryEdges(graph, set) {
  const out = [];
  for (const [u, v] of graph.edges) {
    if (set.has(u)) out.push([u, v]);
  }
  return out;
}

/**
 * Multi-source contamination trace: shortest path from any source to target.
 * Returns { source, path, firstEdge } or null when no source reaches t.
 */
export function firstContamination(graph, sources, target, maxSteps = DEFAULT_MAX_STEPS) {
  if (!graph.nodeSet.has(target)) throw new NoSuchNodeError(target);
  const budget = { remaining: maxSteps };
  const parent = new Map();
  const queue = [];
  for (const s of [...sources].map(String).sort(compareStr)) {
    if (!graph.nodeSet.has(s)) throw new NoSuchNodeError(s);
    if (!parent.has(s)) {
      parent.set(s, null);
      queue.push(s);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    spendSteps(budget);
    const u = queue[head];
    if (u === target) break;
    for (const v of graph.adjacency.get(u)) {
      spendSteps(budget);
      if (!parent.has(v)) {
        parent.set(v, u);
        queue.push(v);
      }
    }
  }
  if (!parent.has(target)) return null;
  const path = [];
  for (let cur = target; cur !== null; cur = parent.get(cur)) path.push(cur);
  path.reverse();
  return {
    source: path[0],
    path,
    firstEdge: path.length > 1 ? [path[0], path[1]] : null,
  };
}
