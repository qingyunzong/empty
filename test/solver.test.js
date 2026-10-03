import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNetting, proofToJson } from '../src/engine.js';
import { netPositions, totalAmount } from '../src/graph.js';
import { residualAfter } from '../src/solver.js';

const RULES_PLAIN = 'nettable = amount;';

const obs = (list) => ({
  obligations: list.map(([id, from, to, amount], i) => ({
    id, day: '2026-10-04', from, to, ccy: 'USD', amount,
  })),
});

const plain = (proof) => JSON.parse(proofToJson(proof));

test('5-member manual cycle is reproducible with canonical rotation', () => {
  const rules = `
day 2026-10-04 {
  nettable = amount;
  expect cycle @M3 -> @M4 -> @M5 -> @M1 -> @M2;
}
`;
  const data = obs([
    ['O1', 'M1', 'M2', 10000],
    ['O2', 'M2', 'M3', 10000],
    ['O3', 'M3', 'M4', 10000],
    ['O4', 'M4', 'M5', 10000],
    ['O5', 'M5', 'M1', 10000],
  ]);
  const usd = plain(runNetting(rules, data)).currencies.USD;
  assert.equal(usd.gross, 50000);
  assert.equal(usd.minCash, 0);
  assert.equal(usd.solutions.length, 1);
  const cyc = usd.solutions[0].cycles[0];
  // canonical form: rotated to start at the smallest member id
  assert.equal(cyc.cycle, 'M1>M2>M3>M4>M5');
  assert.equal(cyc.amount, 10000);
  assert.deepEqual(usd.solutions[0].residual, []);
  for (const v of Object.values(usd.netPositions)) assert.equal(v, 0);
});

test('tied optima: both minimal-cash cycle sets are listed, deterministic order', () => {
  const data = obs([
    ['O1', 'A', 'B', 10],
    ['O2', 'B', 'A', 10],
    ['O3', 'A', 'C', 10],
    ['O4', 'C', 'A', 10],
    ['O5', 'B', 'C', 5],
    ['O6', 'C', 'B', 5],
  ]);
  const proof1 = plain(runNetting(RULES_PLAIN, data));
  const proof2 = plain(runNetting(RULES_PLAIN, data));
  const usd = proof1.currencies.USD;
  assert.equal(usd.minCash, 0);
  const sets = usd.solutions.map((s) => s.cycles.map((c) => `${c.cycle}@${c.amount}`).join('|'));
  assert.deepEqual(sets, [
    'A>B@10|A>C@10|B>C@5',
    'A>B@5|A>B>C@5|A>C@5|A>C>B@5',
  ]);
  // deterministic: identical output across runs
  assert.equal(JSON.stringify(proof1), JSON.stringify(proof2));
});

test('net positions are preserved by every optimal solution', () => {
  const data = obs([
    ['O1', 'A', 'B', 7],
    ['O2', 'B', 'C', 9],
    ['O3', 'C', 'A', 5],
    ['O4', 'A', 'C', 3],
    ['O5', 'B', 'A', 2],
  ]);
  const usd = plain(runNetting(RULES_PLAIN, data)).currencies.USD;
  assert.ok(usd.solutions.length >= 1);
  for (const sol of usd.solutions) {
    const residual = new Map(sol.residual.map((r) => [`${r.from}>${r.to}`, BigInt(r.amount)]));
    const nets = netPositions(residual);
    for (const [m, v] of Object.entries(usd.netPositions)) {
      assert.equal(nets.get(m) ?? 0n, BigInt(v));
    }
    const cancelled = sol.cycles.reduce((t, c) => t + BigInt(c.amount) * BigInt(c.members.length), 0n);
    assert.equal(BigInt(usd.gross) - cancelled, BigInt(sol.residualTotal));
  }
});

test('greedy order is not enough: solver finds the true minimum', () => {
  // Cancelling the 2-cycle first leaves residual 12; optimum is 8.
  const data = obs([
    ['O1', 'A', 'B', 10],
    ['O2', 'B', 'A', 6],
    ['O3', 'A', 'C', 4],
    ['O4', 'C', 'B', 4],
  ]);
  const usd = plain(runNetting(RULES_PLAIN, data)).currencies.USD;
  assert.equal(usd.minCash, 8);
  assert.deepEqual(usd.netPositions, { A: -8, B: 8, C: 0 });
});

test('E_NO_SOL when rules select no obligations', () => {
  const data = obs([['O1', 'A', 'B', 10]]);
  assert.throws(
    () => runNetting('filter currency == EUR;', data),
    (e) => e.code === 'E_NO_SOL',
  );
});

test('E_NO_SOL when an expected cycle is absent from all optima', () => {
  const data = obs([['O1', 'A', 'B', 10]]);
  assert.throws(
    () => runNetting('nettable = amount; expect cycle @A -> @B;', data),
    (e) => e.code === 'E_NO_SOL',
  );
});

test('E_CCY at runtime when a USD-only rule meets a EUR obligation', () => {
  const data = {
    obligations: [
      { id: 'O1', day: '2026-10-04', from: 'A', to: 'B', ccy: 'EUR', amount: 100 },
      { id: 'O2', day: '2026-10-04', from: 'B', to: 'A', ccy: 'EUR', amount: 100 },
    ],
  };
  assert.throws(
    () => runNetting('nettable = amount + 0 USD;', data),
    (e) => e.code === 'E_CCY',
  );
});

test('multi-currency obligations net independently', () => {
  const data = {
    obligations: [
      { id: 'O1', day: '2026-10-04', from: 'A', to: 'B', ccy: 'USD', amount: 100 },
      { id: 'O2', day: '2026-10-04', from: 'B', to: 'A', ccy: 'USD', amount: 100 },
      { id: 'O3', day: '2026-10-04', from: 'A', to: 'B', ccy: 'EUR', amount: 50 },
      { id: 'O4', day: '2026-10-04', from: 'B', to: 'A', ccy: 'EUR', amount: 40 },
    ],
  };
  const proof = plain(runNetting(RULES_PLAIN, data));
  assert.equal(proof.currencies.USD.minCash, 0);
  assert.equal(proof.currencies.EUR.minCash, 10);
  assert.deepEqual(proof.currencies.EUR.netPositions, { A: -10, B: 10 });
});
