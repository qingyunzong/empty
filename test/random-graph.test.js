'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPolicy, ancestorsWithDistance, decide } = require('../lib/index');

// Small deterministic PRNG (mulberry32) so failures reproduce.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Independent oracle: enumerate EVERY directed path from `start` with a
// plain DFS, then take the reachable set and the minimum path length per
// role. Deliberately shares no code with the BFS under test.
function enumerateAllPaths(adj, start) {
  const minDist = new Map([[start, 0]]);
  const visit = (node, depth, onPath) => {
    for (const next of adj.get(node) || []) {
      if (onPath.has(next)) continue; // simple paths only; DAG guarantees termination anyway
      const best = minDist.get(next);
      if (best === undefined || depth + 1 < best) minDist.set(next, depth + 1);
      onPath.add(next);
      visit(next, depth + 1, onPath);
      onPath.delete(next);
    }
  };
  visit(start, 0, new Set([start]));
  return minDist;
}

function randomDag(rand, roleCount, edgeProbability) {
  const roles = Array.from({ length: roleCount }, (_, i) => `role-${i}`);
  // Shuffle to avoid trivially ordered graphs.
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  const records = [];
  // Edge only from later index to earlier index => acyclic by construction.
  for (let i = 0; i < roles.length; i++) {
    for (let j = 0; j < i; j++) {
      if (rand() < edgeProbability) {
        records.push({ type: 'inherit', role: roles[i], inherits: roles[j] });
      }
    }
  }
  return { roles, records };
}

test('random DAGs: ancestor set and min distance match all-paths enumeration', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const rand = rng(seed);
    const roleCount = 3 + Math.floor(rand() * 8); // 3..10 roles
    const { roles, records } = randomDag(rand, roleCount, 0.15 + rand() * 0.35);
    const policy = loadPolicy(records.map((r) => JSON.stringify(r)).join('\n'));

    for (const role of roles) {
      const expected = enumerateAllPaths(policy.adj, role);
      const actual = ancestorsWithDistance(policy.adj, role);

      assert.deepEqual(
        [...actual.keys()].sort(),
        [...expected.keys()].sort(),
        `seed=${seed} role=${role}: ancestor set mismatch`,
      );
      for (const [ancestor, dist] of expected) {
        assert.equal(
          actual.get(ancestor).distance,
          dist,
          `seed=${seed} role=${role} ancestor=${ancestor}: min distance mismatch`,
        );
      }
      // recorded path must be a real chain of the stated length
      for (const info of actual.values()) {
        assert.equal(info.path.length, info.distance + 1);
        assert.equal(info.path[0], role);
        for (let k = 0; k + 1 < info.path.length; k++) {
          assert.ok(
            (policy.adj.get(info.path[k]) || new Set()).has(info.path[k + 1]),
            `seed=${seed}: path edge ${info.path[k]} -> ${info.path[k + 1]} missing`,
          );
        }
      }
    }
  }
});

test('random DAGs with rules: decisions stay consistent with oracle ancestors', () => {
  for (let seed = 100; seed < 120; seed++) {
    const rand = rng(seed);
    const roleCount = 4 + Math.floor(rand() * 6);
    const { roles, records } = randomDag(rand, roleCount, 0.3);
    let ruleNo = 0;
    for (const role of roles) {
      if (rand() < 0.7) {
        records.push({
          type: 'rule',
          id: `rule-${ruleNo++}`,
          role,
          resource: 'res',
          effect: rand() < 0.5 ? 'allow' : 'deny',
        });
      }
    }
    const policy = loadPolicy(records.map((r) => JSON.stringify(r)).join('\n'));

    for (const role of roles) {
      const d = decide(policy, { id: 'e', role, resource: 'res', ts: 1 });
      const oracle = enumerateAllPaths(policy.adj, role);
      const applicable = policy.rules.filter(
        (r) => r.resource === 'res' && oracle.has(r.role),
      );
      if (applicable.length === 0) {
        assert.equal(d.decision, 'deny');
        assert.equal(d.reason, 'DEFAULT_DENY');
        continue;
      }
      // oracle-side winner: deny first, then min distance, then id
      const sorted = [...applicable].sort((a, b) => {
        if (a.effect !== b.effect) return a.effect === 'deny' ? -1 : 1;
        const dd = oracle.get(a.role) - oracle.get(b.role);
        if (dd !== 0) return dd;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      assert.equal(d.rule, sorted[0].id, `seed=${seed} role=${role}`);
      assert.equal(d.decision, sorted[0].effect);
    }
  }
});
