import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClearingEngine } from '../src/engine.js';
import { aggregateEdges, bilateralOffset, findSimpleCycles } from '../src/graph.js';
import { toBase } from '../src/rates.js';
import { bruteNetPositions, bruteBilateralOffsets, makeRng } from './helpers.js';

const RATES = { USD: 1000000, EUR: 1100000, JPY: 9000 };
const CCYS = Object.keys(RATES);
const PARTICIPANTS = ['p0', 'p1', 'p2', 'p3'];

function randomTrades(rng, n) {
  const trades = [];
  for (let i = 0; i < n; i++) {
    const from = rng.pick(PARTICIPANTS);
    let to = rng.pick(PARTICIPANTS);
    while (to === from) to = rng.pick(PARTICIPANTS);
    trades.push({ id: `t${i}`, from, to, ccy: rng.pick(CCYS), amount: rng.int(1, 500) });
  }
  return trades;
}

function positionsFromResidual(residualFlows) {
  const pos = new Map();
  for (const f of residualFlows) {
    pos.set(f.from, (pos.get(f.from) ?? 0) - f.amount);
    pos.set(f.to, (pos.get(f.to) ?? 0) + f.amount);
  }
  return pos;
}

test('n<=8 randomized cross-check against brute-force enumeration', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rng = makeRng(seed);
    const n = rng.int(1, 8);
    const trades = randomTrades(rng, n);

    const e = new ClearingEngine({ base: 'USD' });
    e.addRateVersion(1, RATES);
    e.setTrades(trades);
    const r = e.settle();

    // 1. Net positions equal the brute-force invariant.
    const brute = bruteNetPositions(trades, RATES);
    for (const [p, v] of brute) {
      assert.equal(r.netPositions[p] ?? 0, v, `seed ${seed} participant ${p}`);
    }
    for (const p of Object.keys(r.netPositions)) {
      assert.equal(r.netPositions[p], brute.get(p) ?? 0, `seed ${seed} participant ${p}`);
    }

    // 2. The engine's bilateral stage equals enumerating all bilateral offsets.
    const converted = trades
      .map((t) => ({ ...t, baseAmount: toBase(t.amount, RATES[t.ccy]) }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const engineBilat = bilateralOffset(aggregateEdges(converted));
    const engineBilatMap = new Map();
    for (const edge of engineBilat.values()) {
      engineBilatMap.set(edge.from + '->' + edge.to, edge.weight);
    }
    assert.deepEqual(engineBilatMap, bruteBilateralOffsets(trades, RATES), `seed ${seed} bilateral offsets`);

    // 3. Residual is acyclic and realizes the same net positions.
    const residualEdges = new Map();
    for (const f of r.residualFlows) {
      residualEdges.set(f.from + '->' + f.to, { from: f.from, to: f.to, weight: f.amount, tradeIds: [] });
    }
    assert.equal(findSimpleCycles(residualEdges).length, 0, `seed ${seed} residual acyclic`);
    const realized = positionsFromResidual(r.residualFlows);
    for (const [p, v] of realized) {
      assert.equal(r.netPositions[p], v, `seed ${seed} realized ${p}`);
    }

    // 4. Locks equal net debits; window total is consistent.
    let total = 0;
    for (const p of Object.keys(r.netPositions)) {
      const lock = Math.max(0, -r.netPositions[p]);
      assert.equal(r.locks[p] ?? 0, lock, `seed ${seed} lock ${p}`);
      total += lock;
    }
    assert.equal(r.window.locked, total);
  }
});

test('randomized voids keep net positions equal to brute force of remaining trades', () => {
  for (let seed = 1000; seed <= 1100; seed++) {
    const rng = makeRng(seed);
    const n = rng.int(2, 8);
    const trades = randomTrades(rng, n);
    const e = new ClearingEngine({ base: 'USD' });
    e.addRateVersion(1, RATES);
    e.setTrades(trades);
    e.settle();
    const voided = trades[rng.int(0, n - 1)].id;
    const r = e.voidTrade(voided);
    const remaining = trades.filter((t) => t.id !== voided);
    const brute = bruteNetPositions(remaining, RATES);
    for (const [p, v] of brute) {
      assert.equal(r.netPositions[p] ?? 0, v, `seed ${seed} participant ${p}`);
    }
    for (const p of Object.keys(r.netPositions)) {
      assert.equal(r.netPositions[p], brute.get(p) ?? 0, `seed ${seed} participant ${p}`);
    }
  }
});
