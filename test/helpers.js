'use strict';

// Independent feasibility check via the Hoffmann circulation theorem:
// a circulation with bounds exists iff for every subset X of nodes,
// sum of lower bounds on edges X -> V\X <= sum of upper bounds on edges V\X -> X.
function subsetCutFeasible(nodes, edges) {
  const index = new Map(nodes.map((name, i) => [name, i]));
  const n = nodes.length;
  for (let mask = 0; mask < 1 << n; mask += 1) {
    let lowerOut = 0;
    let upperIn = 0;
    for (const edge of edges) {
      const fromIn = (mask >> index.get(edge.from)) & 1;
      const toIn = (mask >> index.get(edge.to)) & 1;
      if (fromIn && !toIn) lowerOut += edge.lower;
      if (!fromIn && toIn) upperIn += edge.upper;
    }
    if (lowerOut > upperIn) return false;
  }
  return true;
}

// Brute-force enumeration of all integral flows within bounds.
// Returns null when the search space is too large to enumerate.
function bruteForceFeasible(nodes, edges, limit = 300000) {
  const space = edges.reduce((acc, e) => acc * (e.upper - e.lower + 1), 1);
  if (space > limit) return null;
  const assignment = new Array(edges.length).fill(0);
  const balance = new Map(nodes.map((name) => [name, 0]));
  const nodesList = [...balance.keys()];

  function search(i) {
    if (i === edges.length) {
      return nodesList.every((name) => balance.get(name) === 0);
    }
    const edge = edges[i];
    for (let f = edge.lower; f <= edge.upper; f += 1) {
      assignment[i] = f;
      balance.set(edge.from, balance.get(edge.from) - f);
      balance.set(edge.to, balance.get(edge.to) + f);
      if (search(i + 1)) return true;
      balance.set(edge.from, balance.get(edge.from) + f);
      balance.set(edge.to, balance.get(edge.to) - f);
    }
    return false;
  }
  return search(0);
}

// Validate that a flows object is a genuine feasible circulation.
function assertValidCirculation(assert, edges, flows) {
  const balance = new Map();
  for (const edge of edges) {
    const key = `${edge.from}->${edge.to}`;
    assert.ok(Object.prototype.hasOwnProperty.call(flows, key), `missing flow for ${key}`);
    const f = flows[key];
    assert.ok(Number.isInteger(f), `flow on ${key} must be an integer`);
    assert.ok(f >= edge.lower, `flow ${f} below lower ${edge.lower} on ${key}`);
    assert.ok(f <= edge.upper, `flow ${f} above upper ${edge.upper} on ${key}`);
    balance.set(edge.from, (balance.get(edge.from) || 0) - f);
    balance.set(edge.to, (balance.get(edge.to) || 0) + f);
  }
  assert.strictEqual(Object.keys(flows).length, edges.length, 'no extra flows may be reported');
  for (const [node, net] of balance) {
    assert.strictEqual(net, 0, `conservation violated at ${node}`);
  }
}

// Deterministic PRNG (mulberry32).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomGraph(rand, { maxNodes = 7, maxUpper = 10 } = {}) {
  const n = 2 + Math.floor(rand() * (maxNodes - 1)); // 2..maxNodes
  const nodes = Array.from({ length: n }, (_, i) => `N${i}`);
  const pairs = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (i !== j) pairs.push([nodes[i], nodes[j]]);
    }
  }
  const m = Math.floor(rand() * Math.min(pairs.length, n + 3));
  const edges = [];
  const used = new Set();
  while (edges.length < m && used.size < pairs.length) {
    const [from, to] = pairs[Math.floor(rand() * pairs.length)];
    const key = `${from}->${to}`;
    if (used.has(key)) continue;
    used.add(key);
    const upper = Math.floor(rand() * (maxUpper + 1));
    const lower = Math.floor(rand() * (upper + 1));
    edges.push({ from, to, lower, upper });
  }
  return { nodes, edges };
}

module.exports = { subsetCutFeasible, bruteForceFeasible, assertValidCirculation, mulberry32, randomGraph };
