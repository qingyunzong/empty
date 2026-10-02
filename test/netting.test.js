import test from 'node:test';
import assert from 'node:assert/strict';
import { runNetting } from '../src/engine.js';
import { enumerateCycles, canonCycle, verifySolution } from '../src/netting.js';
import { buildGraphs } from '../src/graph.js';

const RULES = 'date 2026-10-02 { filter amount >= 1; }';
const ob = (id, debtor, creditor, amount, ccy = 'USD') =>
  ({ id, debtor, creditor, ccy, amount, date: '2026-10-02' });

test('acceptance 1: 5-member manual ring is reproducible', () => {
  const obs = [
    ob('o1', 'M1', 'M2', 25000),
    ob('o2', 'M2', 'M3', 25000),
    ob('o3', 'M3', 'M4', 25000),
    ob('o4', 'M4', 'M5', 25000),
    ob('o5', 'M5', 'M1', 25000),
    ob('o6', 'M1', 'M3', 10000),
  ];
  const r = runNetting(RULES, obs);
  const usd = r.currencies.USD;
  assert.equal(usd.gross, 135000);
  assert.equal(usd.cancelled, 125000);
  assert.equal(usd.minCash, 10000);
  assert.deepEqual(usd.positions, { M1: -10000, M2: 0, M3: 10000, M4: 0, M5: 0 });
  assert.equal(usd.solutions.length, 1);
  const sol = usd.solutions[0];
  assert.equal(sol.cycles.length, 1);
  assert.deepEqual(sol.cycles[0].cycle, ['M1', 'M2', 'M3', 'M4', 'M5']);
  assert.equal(sol.cycles[0].amount, 25000);
  // every cancelled cent is attributed to a cycle edge and its obligations
  assert.equal(sol.cycles[0].edges.length, 5);
  assert.deepEqual(sol.cycles[0].edges[0].obligations, ['o1']);
  assert.deepEqual(sol.settlements, [
    { from: 'M1', to: 'M3', amount: 10000, obligations: ['o6'] },
  ]);
});

test('acceptance 2: tied optima are all listed in deterministic order', () => {
  const obs = [
    ob('a1', 'MA', 'MB', 10000), ob('a2', 'MB', 'MA', 10000),
    ob('a3', 'MB', 'MC', 10000), ob('a4', 'MC', 'MB', 10000),
    ob('a5', 'MA', 'MC', 10000), ob('a6', 'MC', 'MA', 10000),
  ];
  const r1 = runNetting(RULES, obs);
  const r2 = runNetting(RULES, obs);
  const usd = r1.currencies.USD;
  assert.equal(usd.minCash, 0);
  assert.equal(usd.solutions.length, 2);
  const shapes = usd.solutions.map((s) => s.cycles.map((c) => c.cycle.join('>')).sort());
  assert.deepEqual(shapes, [
    ['MA>MB', 'MA>MC', 'MB>MC'],       // three 2-cycles
    ['MA>MB>MC', 'MA>MC>MB'],          // two 3-cycles
  ]);
  // deterministic: identical output on a second run
  assert.deepEqual(r1, r2);
});

test('canonical cycle: rotation equivalents collapse to one', () => {
  assert.deepEqual(canonCycle(['B', 'C', 'A']), ['A', 'B', 'C']);
  const members = ['A', 'B', 'C'];
  const adj = new Map([['A', ['B']], ['B', ['C']], ['C', ['A']]]);
  const cycles = enumerateCycles(members, adj);
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0], ['A', 'B', 'C']);
});

test('net positions are preserved by every solution', () => {
  const obs = [
    ob('x1', 'P', 'Q', 700), ob('x2', 'Q', 'P', 300),
    ob('x3', 'Q', 'R', 900), ob('x4', 'R', 'P', 200),
    ob('x5', 'P', 'R', 100),
  ];
  const kept = obs;
  const g = buildGraphs(kept).get('USD');
  const r = runNetting(RULES, obs);
  for (const sol of r.currencies.USD.solutions) {
    assert.ok(verifySolution(g, sol));
  }
});
