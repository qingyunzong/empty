import test from 'node:test';
import assert from 'node:assert/strict';
import { runNetting } from '../src/engine.js';
import { buildGraphs } from '../src/graph.js';
import { optimize, verifySolution } from '../src/netting.js';
import { referenceOptimize } from '../src/reference.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RULES = 'date 2026-10-02 { filter amount >= 1; }';

function randomObs(rand, n) {
  const members = ['M1', 'M2', 'M3', 'M4', 'M5'];
  const ccys = ['USD', 'EUR'];
  const obs = [];
  for (let i = 0; i < n; i++) {
    let d = members[Math.floor(rand() * members.length)];
    let c = members[Math.floor(rand() * members.length)];
    while (c === d) c = members[Math.floor(rand() * members.length)];
    obs.push({
      id: `r${i}`,
      debtor: d,
      creditor: c,
      ccy: ccys[Math.floor(rand() * ccys.length)],
      amount: 1 + Math.floor(rand() * 50000),
      date: '2026-10-02',
    });
  }
  return obs;
}

const engineKey = (sol) => JSON.stringify({
  c: sol.cycles.map((c) => [c.key, c.amount]).sort(),
  r: sol.settlements.map((s) => [s.from, s.to, s.amount]).sort(),
});

test('acceptance 4: random 30 obligations cross-checked against brute-force reference', () => {
  const SEEDS = 12;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rand = mulberry32(seed * 7919);
    const obs = randomObs(rand, 30);
    const proof = runNetting(RULES, obs);
    const graphs = buildGraphs(obs);
    for (const [ccy, g] of graphs) {
      const engine = optimize(g);
      const ref = referenceOptimize(
        [...g.members],
        [...g.edges.values()].map((e) => ({ from: e.from, to: e.to, amount: e.amount })),
      );
      // minimum cash matches the independent reference
      assert.equal(engine.minCash, ref.minCash, `seed ${seed} ${ccy}: minCash`);
      assert.equal(proof.currencies[ccy].minCash, ref.minCash);
      // identical set of tied optima
      const engineKeys = new Set(engine.solutions.map(engineKey));
      assert.deepEqual(engineKeys, ref.solKeys, `seed ${seed} ${ccy}: solution sets`);
      // every solution preserves each member's net position
      for (const sol of engine.solutions) {
        assert.ok(verifySolution(g, sol), `seed ${seed} ${ccy}: invariant`);
      }
      // positions in the proof equal positions recomputed from raw obligations
      const pos = new Map();
      for (const o of obs.filter((x) => x.ccy === ccy)) {
        pos.set(o.creditor, (pos.get(o.creditor) || 0) + o.amount);
        pos.set(o.debtor, (pos.get(o.debtor) || 0) - o.amount);
      }
      for (const [m, p] of pos) {
        assert.equal(proof.currencies[ccy].positions[m], p, `seed ${seed} ${ccy} ${m}`);
      }
    }
  }
});
