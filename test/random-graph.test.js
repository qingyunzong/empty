'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPolicy, computeAncestors } = require('../lib/policy');

// Deterministic PRNG so failures are reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Independent reference: enumerate ALL inheritance paths by DFS, then derive
// the ancestor set and each ancestor's minimum hop distance.
function enumerateAllPaths(roles, start) {
  const paths = [];
  const dfs = (node, path) => {
    for (const parent of roles.get(node) ?? []) {
      if (path.includes(parent)) continue; // guard; input is a DAG
      paths.push([...path, parent]);
      dfs(parent, [...path, parent]);
    }
  };
  dfs(start, [start]);
  return paths;
}

function referenceAncestors(roles, start) {
  const best = new Map([[start, 0]]);
  for (const path of enumerateAllPaths(roles, start)) {
    const node = path[path.length - 1];
    const dist = path.length - 1;
    if (!best.has(node) || dist < best.get(node)) best.set(node, dist);
  }
  return best;
}

test('random DAGs: ancestors and shortest distances match brute-force path enumeration', () => {
  const rand = mulberry32(20261003);
  for (let trial = 0; trial < 200; trial++) {
    const n = 2 + Math.floor(rand() * 11); // 2..12 roles
    const names = Array.from({ length: n }, (_, i) => `role${i}`);
    const lines = names.map((name) => {
      const idx = names.indexOf(name);
      const parents = [];
      for (let j = idx + 1; j < n; j++) {
        if (rand() < 0.3) parents.push(names[j]); // edges only to higher indices => DAG
      }
      return JSON.stringify({ type: 'role', role: name, inherits: parents });
    });
    const policy = loadPolicy(lines.join('\n'));

    const rolesOnly = new Map(names.map((nm) => [nm, policy.roles.get(nm).inherits]));
    const start = names[Math.floor(rand() * n)];

    const actual = computeAncestors(policy, start);
    const expected = referenceAncestors(rolesOnly, start);

    assert.deepEqual(
      [...actual.keys()].sort(),
      [...expected.keys()].sort(),
      `trial ${trial}: ancestor set mismatch for ${start}`,
    );
    for (const [node, info] of actual) {
      assert.equal(info.dist, expected.get(node), `trial ${trial}: dist mismatch for ${node}`);
      // reported path must be a genuine path of minimal length
      assert.equal(info.path[0], start);
      assert.equal(info.path[info.path.length - 1], node);
      assert.equal(info.path.length - 1, info.dist);
      for (let k = 0; k + 1 < info.path.length; k++) {
        assert.ok(rolesOnly.get(info.path[k]).includes(info.path[k + 1]),
          `trial ${trial}: ${info.path[k]} -> ${info.path[k + 1]} is not an edge`);
      }
    }
  }
});
