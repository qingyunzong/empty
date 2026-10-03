import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNetting, proofToJson } from '../src/engine.js';

// ---- independent reference implementations (no shared code with src/) ----

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// All directed simple cycles as arrays of edge indices, found by brute-force
// permutation of node arrangements (canonical: first node is the minimum).
function refCycles(numNodes, edges) {
  const amt = new Map();
  edges.forEach(([f, t, a], i) => { if (a > 0) amt.set(`${f},${t}`, i); });
  const cycles = [];
  const perm = [];
  const used = new Array(numNodes).fill(false);
  const rec = () => {
    if (perm.length >= 2) {
      const idx = [];
      let ok = true;
      for (let i = 0; i < perm.length; i++) {
        const e = amt.get(`${perm[i]},${perm[(i + 1) % perm.length]}`);
        if (e === undefined) { ok = false; break; }
        idx.push(e);
      }
      if (ok) cycles.push(idx);
    }
    if (perm.length === numNodes) return;
    for (let v = 0; v < numNodes; v++) {
      if (used[v]) continue;
      if (perm.length > 0 && v < perm[0]) continue;
      used[v] = true; perm.push(v);
      rec();
      perm.pop(); used[v] = false;
    }
  };
  rec();
  return cycles;
}

// Reference: memoized DFS over cancellation sequences -> minimal residual cash.
function refMinCash(numNodes, edges) {
  const memo = new Map();
  const go = (st) => {
    const key = st.filter((e) => e[2] > 0).map((e) => e.join(',')).sort().join(';');
    if (memo.has(key)) return memo.get(key);
    const cycles = refCycles(numNodes, st);
    let result;
    if (cycles.length === 0) {
      result = st.reduce((t, e) => t + e[2], 0);
    } else {
      result = Infinity;
      for (const cyc of cycles) {
        const b = Math.min(...cyc.map((ei) => st[ei][2]));
        const next = st.map((e, i) => (cyc.includes(i) ? [e[0], e[1], e[2] - b] : e));
        result = Math.min(result, go(next));
      }
    }
    memo.set(key, result);
    return result;
  };
  return go(edges);
}

// Reference: brute-force over all subsets of the initial cycle set,
// applying each subset in sorted order. Gives an upper bound on the optimum.
function refSubsetBound(numNodes, edges) {
  const cycles = refCycles(numNodes, edges);
  assert.ok(cycles.length <= 22, 'subset reference needs a small cycle count');
  let best = Infinity;
  for (let mask = 0; mask < (1 << cycles.length); mask++) {
    const st = edges.map((e) => [...e]);
    for (let b = 0; b < cycles.length; b++) {
      if (!(mask & (1 << b))) continue;
      const cyc = cycles[b];
      const bottleneck = Math.min(...cyc.map((ei) => st[ei][2]));
      if (bottleneck <= 0) continue;
      for (const ei of cyc) st[ei][2] -= bottleneck;
    }
    best = Math.min(best, st.reduce((t, e) => t + e[2], 0));
  }
  return best;
}

function genCase(seed, numMembers, numObs) {
  const rnd = mulberry32(seed);
  const obligations = [];
  for (let i = 0; i < numObs; i++) {
    let f;
    let t;
    do {
      f = Math.floor(rnd() * numMembers);
      t = Math.floor(rnd() * numMembers);
    } while (f === t);
    obligations.push({
      id: `O${i}`, day: '2026-10-04',
      from: `M${f}`, to: `M${t}`, ccy: 'USD',
      amount: 1 + Math.floor(rnd() * 5000),
    });
  }
  return obligations;
}

function toEdgeList(obligations, numMembers) {
  const agg = new Map();
  for (const o of obligations) {
    const f = Number(o.from.slice(1));
    const t = Number(o.to.slice(1));
    const k = `${f},${t}`;
    agg.set(k, (agg.get(k) ?? 0) + o.amount);
  }
  return [...agg.entries()].map(([k, a]) => { const [f, t] = k.split(',').map(Number); return [f, t, a]; });
}

function checkInvariants(usd, obligations) {
  // net positions from the raw obligations
  const nets = new Map();
  for (const o of obligations) {
    nets.set(o.from, (nets.get(o.from) ?? 0) - o.amount);
    nets.set(o.to, (nets.get(o.to) ?? 0) + o.amount);
  }
  for (const [m, v] of nets) assert.equal(usd.netPositions[m], v, `net position ${m}`);
  // theoretical lower bound: sum of positive net positions
  const lb = [...nets.values()].filter((v) => v > 0).reduce((a, b) => a + b, 0);
  assert.ok(usd.minCash >= lb, 'minCash below net-position lower bound');
  for (const sol of usd.solutions) {
    // residual preserves net positions
    const rn = new Map();
    for (const r of sol.residual) {
      rn.set(r.from, (rn.get(r.from) ?? 0) - r.amount);
      rn.set(r.to, (rn.get(r.to) ?? 0) + r.amount);
    }
    for (const [m, v] of nets) assert.equal(rn.get(m) ?? 0, v, `residual net ${m}`);
    // every cancelled cent is explained by a listed cycle
    const cancelled = sol.cycles.reduce((t, c) => t + c.amount * c.members.length, 0);
    assert.equal(usd.gross - cancelled, sol.residualTotal);
    assert.equal(sol.residualTotal, usd.minCash);
    // residual must be acyclic (fully netted)
    const adj = new Map();
    for (const r of sol.residual) {
      if (!adj.has(r.from)) adj.set(r.from, []);
      adj.get(r.from).push(r.to);
    }
    const color = new Map();
    const dfs = (u) => {
      color.set(u, 1);
      for (const v of adj.get(u) ?? []) {
        assert.notEqual(color.get(v), 1, 'residual contains a cycle');
        if (!color.has(v)) dfs(v);
      }
      color.set(u, 2);
    };
    for (const m of adj.keys()) if (!color.has(m)) dfs(m);
  }
}

test('random 30 obligations: solver matches DFS reference and preserves net positions', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const obligations = genCase(seed, 4, 30);
    const proof = JSON.parse(proofToJson(runNetting('nettable = amount;', { obligations })));
    const usd = proof.currencies.USD;
    const edges = toEdgeList(obligations, 4);
    assert.equal(usd.minCash, refMinCash(4, edges), `seed ${seed} minCash`);
    checkInvariants(usd, obligations);
  }
});

test('small random cases: solver matches subset brute force bound and DFS reference', () => {
  for (const seed of [11, 12, 13]) {
    const obligations = genCase(seed, 3, 8);
    const proof = JSON.parse(proofToJson(runNetting('nettable = amount;', { obligations })));
    const usd = proof.currencies.USD;
    const edges = toEdgeList(obligations, 3);
    assert.equal(usd.minCash, refMinCash(3, edges), `seed ${seed} minCash`);
    assert.ok(usd.minCash <= refSubsetBound(3, edges), `seed ${seed} subset bound`);
    checkInvariants(usd, obligations);
  }
});
