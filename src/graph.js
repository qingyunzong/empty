'use strict';

const crypto = require('node:crypto');

function sha256hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalize(value[k]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

function normalizeGraph(nodes, edges) {
  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    throw new TypeError('nodes and edges must be arrays');
  }
  const nodeSet = new Set(nodes.map(String));
  const seen = new Set();
  const normEdges = [];
  for (const e of edges) {
    const from = String(Array.isArray(e) ? e[0] : e.from);
    const to = String(Array.isArray(e) ? e[1] : e.to);
    nodeSet.add(from);
    nodeSet.add(to);
    const key = from + '->' + to;
    if (!seen.has(key)) {
      seen.add(key);
      normEdges.push({ from, to });
    }
  }
  normEdges.sort((a, b) => (a.from + '->' + a.to).localeCompare(b.from + '->' + b.to));
  return { nodes: [...nodeSet].sort(), edges: normEdges };
}

function graphVersion(graph) {
  return sha256hex('graph-v1|' + canonicalize({ nodes: graph.nodes, edges: graph.edges }));
}

function buildAdjacency(graph) {
  const adj = new Map();
  for (const n of graph.nodes) adj.set(n, []);
  for (const e of graph.edges) adj.get(e.from).push(e.to);
  return adj;
}

function buildReverseAdjacency(graph) {
  const adj = new Map();
  for (const n of graph.nodes) adj.set(n, []);
  for (const e of graph.edges) adj.get(e.to).push(e.from);
  return adj;
}

function bfsReachable(graph, s) {
  const adj = buildAdjacency(graph);
  const visited = new Set([s]);
  const queue = [s];
  while (queue.length > 0) {
    const u = queue.shift();
    for (const v of adj.get(u) || []) {
      if (!visited.has(v)) {
        visited.add(v);
        queue.push(v);
      }
    }
  }
  return visited;
}

function bfsPath(graph, s, t) {
  if (s === t) return [s];
  const adj = buildAdjacency(graph);
  const parent = new Map([[s, null]]);
  const queue = [s];
  while (queue.length > 0) {
    const u = queue.shift();
    for (const v of adj.get(u) || []) {
      if (!parent.has(v)) {
        parent.set(v, u);
        if (v === t) {
          const path = [t];
          let cur = u;
          while (cur !== null) {
            path.unshift(cur);
            cur = parent.get(cur);
          }
          return path;
        }
        queue.push(v);
      }
    }
  }
  return null;
}

module.exports = {
  sha256hex,
  canonicalize,
  normalizeGraph,
  graphVersion,
  buildAdjacency,
  buildReverseAdjacency,
  bfsReachable,
  bfsPath,
};
