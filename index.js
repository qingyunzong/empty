#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

class InputError extends Error {}

function edgeKey(edge) {
  return edge.child + ' ' + edge.parent;
}

function sameEdgeState(a, b) {
  if (a === undefined || b === undefined) return a === b;
  return a.relation === b.relation;
}

function canonicalize(version) {
  const nodes = [...version.nodes].sort();
  const edges = [...version.edges.values()]
    .map((e) => ({ child: e.child, parent: e.parent, relation: e.relation }))
    .sort((x, y) => (edgeKey(x) < edgeKey(y) ? -1 : 1));
  return JSON.stringify({ nodes, edges });
}

function hashVersion(version) {
  return crypto.createHash('sha256').update(canonicalize(version)).digest('hex');
}

function assertString(value, what) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InputError(`${what} must be a non-empty string`);
  }
}

function normalizeVersion(raw, label) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InputError(`${label}: top-level value must be a JSON object`);
  }
  const nodes = new Set();
  if (raw.nodes !== undefined) {
    if (!Array.isArray(raw.nodes)) throw new InputError(`${label}: "nodes" must be an array`);
    for (const n of raw.nodes) {
      assertString(n, `${label}: node id`);
      nodes.add(n);
    }
  }
  if (raw.lots !== undefined) {
    if (!Array.isArray(raw.lots)) throw new InputError(`${label}: "lots" must be an array`);
    for (const lot of raw.lots) {
      if (lot === null || typeof lot !== 'object' || Array.isArray(lot)) {
        throw new InputError(`${label}: lot must be an object`);
      }
      assertString(lot.id, `${label}: lot id`);
      if (!Array.isArray(lot.batches)) {
        throw new InputError(`${label}: lot "${lot.id}" batches must be an array`);
      }
      for (const b of lot.batches) {
        assertString(b, `${label}: batch id`);
        nodes.add(b);
      }
    }
  }
  const edges = new Map();
  if (raw.edges !== undefined) {
    if (!Array.isArray(raw.edges)) throw new InputError(`${label}: "edges" must be an array`);
    for (const e of raw.edges) {
      if (e === null || typeof e !== 'object' || Array.isArray(e)) {
        throw new InputError(`${label}: edge must be an object`);
      }
      assertString(e.child, `${label}: edge child`);
      assertString(e.parent, `${label}: edge parent`);
      assertString(e.relation, `${label}: edge relation`);
      if (e.child === e.parent) {
        throw new InputError(`${label}: self-loop edge "${e.child}" -> "${e.parent}"`);
      }
      if (!nodes.has(e.child) || !nodes.has(e.parent)) {
        throw new InputError(
          `${label}: edge "${e.child}" -> "${e.parent}" references an unknown node`
        );
      }
      const key = edgeKey(e);
      const existing = edges.get(key);
      if (existing && existing.relation !== e.relation) {
        throw new InputError(
          `${label}: duplicate edge "${e.child}" -> "${e.parent}" with conflicting relations`
        );
      }
      edges.set(key, { child: e.child, parent: e.parent, relation: e.relation });
    }
  }
  const version = { nodes, edges };
  const cycle = findCycle(nodes, edges);
  if (cycle) {
    throw new InputError(`${label}: graph contains a directed cycle: ${cycle.join(' -> ')}`);
  }
  return version;
}

function buildAdjacency(edges) {
  const adj = new Map();
  for (const e of edges.values()) {
    if (!adj.has(e.child)) adj.set(e.child, []);
    adj.get(e.child).push(e.parent);
  }
  return adj;
}

function findCycle(nodes, edges) {
  const adj = buildAdjacency(edges);
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  for (const n of nodes) color.set(n, WHITE);
  const stack = [];
  let cyclePath = null;
  function dfs(u) {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of adj.get(u) || []) {
      if (cyclePath) return;
      const c = color.get(v);
      if (c === GRAY) {
        cyclePath = stack.slice(stack.indexOf(v)).concat(v);
        return;
      }
      if (c === WHITE) dfs(v);
    }
    stack.pop();
    color.set(u, BLACK);
  }
  for (const n of nodes) {
    if (cyclePath) break;
    if (color.get(n) === WHITE) dfs(n);
  }
  return cyclePath;
}

function isDag(nodes, edges) {
  return findCycle(nodes, edges) === null;
}

function reachableFrom(edges, start) {
  const adj = buildAdjacency(edges);
  const seen = new Set();
  const stack = [start];
  while (stack.length > 0) {
    const u = stack.pop();
    for (const v of adj.get(u) || []) {
      if (!seen.has(v)) {
        seen.add(v);
        stack.push(v);
      }
    }
  }
  return seen;
}

function mergeVersions(base, local, remote) {
  const conflicts = [];

  const mergedNodes = new Set();
  const allNodes = new Set([...base.nodes, ...local.nodes, ...remote.nodes]);
  for (const n of allNodes) {
    const b = base.nodes.has(n);
    const l = local.nodes.has(n);
    const r = remote.nodes.has(n);
    let take;
    if (l === b) take = r;
    else if (r === b) take = l;
    else if (l === r) take = l;
    else {
      conflicts.push({ type: 'node-conflict', node: n, base: b, local: l, remote: r });
      continue;
    }
    if (take) mergedNodes.add(n);
  }

  const mergedEdges = new Map();
  const allKeys = new Set([...base.edges.keys(), ...local.edges.keys(), ...remote.edges.keys()]);
  for (const key of allKeys) {
    const b = base.edges.get(key);
    const l = local.edges.get(key);
    const r = remote.edges.get(key);
    const sample = b || l || r;
    if (sameEdgeState(l, b)) {
      if (r) mergedEdges.set(key, r);
    } else if (sameEdgeState(r, b)) {
      if (l) mergedEdges.set(key, l);
    } else if (sameEdgeState(l, r)) {
      if (l) mergedEdges.set(key, l);
    } else {
      conflicts.push({
        type: 'edge-conflict',
        child: sample.child,
        parent: sample.parent,
        base: b ? b.relation : null,
        local: l ? l.relation : null,
        remote: r ? r.relation : null,
      });
    }
  }

  for (const e of mergedEdges.values()) {
    if (!mergedNodes.has(e.child) || !mergedNodes.has(e.parent)) {
      conflicts.push({
        type: 'dangling-reference',
        child: e.child,
        parent: e.parent,
        detail: 'merged edge references a node that does not exist in the merged graph',
      });
    }
    if (e.child === e.parent) {
      conflicts.push({ type: 'self-loop', child: e.child, parent: e.parent });
    }
  }

  const cycle = findCycle(mergedNodes, mergedEdges);
  if (cycle) {
    conflicts.push({
      type: 'cycle',
      path: cycle,
      detail: 'merged graph contains a directed cycle',
    });
  }

  return { merged: { nodes: mergedNodes, edges: mergedEdges }, conflicts };
}

function mergedToJson(merged) {
  return {
    nodes: [...merged.nodes].sort(),
    edges: [...merged.edges.values()]
      .map((e) => ({ child: e.child, parent: e.parent, relation: e.relation }))
      .sort((x, y) => (edgeKey(x) < edgeKey(y) ? -1 : 1)),
  };
}

function readVersionFile(path, label) {
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (err) {
    throw new InputError(`${label}: cannot read file "${path}": ${err.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new InputError(`${label}: invalid JSON in "${path}": ${err.message}`);
  }
  return normalizeVersion(raw, label);
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new InputError(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new InputError(`missing value for --${key}`);
    }
    opts[key] = value;
    i += 1;
  }
  return opts;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command !== 'merge-genealogy') {
    process.stderr.write(
      'usage: node index.js merge-genealogy --base <file> --local <file> --remote <file> --out <file>\n'
    );
    return 2;
  }
  let opts;
  let result;
  try {
    opts = parseArgs(rest);
    for (const k of ['base', 'local', 'remote', 'out']) {
      if (!opts[k]) throw new InputError(`missing required option --${k}`);
    }
    const base = readVersionFile(opts.base, 'base');
    const local = readVersionFile(opts.local, 'local');
    const remote = readVersionFile(opts.remote, 'remote');
    const { merged, conflicts } = mergeVersions(base, local, remote);
    result = {
      status: conflicts.length === 0 ? 'merged' : 'conflict',
      merged: mergedToJson(merged),
      conflicts,
      baseHash: hashVersion(base),
      localHash: hashVersion(local),
      remoteHash: hashVersion(remote),
    };
  } catch (err) {
    if (err instanceof InputError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
  try {
    fs.writeFileSync(opts.out, JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`error: cannot write output: ${err.message}\n`);
    return 2;
  }
  process.stdout.write(
    `${result.status}: ${result.conflicts.length} conflict(s), result written to ${opts.out}\n`
  );
  return result.conflicts.length === 0 ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  InputError,
  normalizeVersion,
  mergeVersions,
  mergedToJson,
  hashVersion,
  canonicalize,
  findCycle,
  isDag,
  reachableFrom,
  edgeKey,
  main,
};
