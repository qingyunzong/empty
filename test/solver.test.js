import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solve } from '../src/solver.js';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const H = 3600_000;

function bruteForce(carriers, tools, scoreByLot) {
  // Enumerate every assignment of carriers -> tools ∪ {unassigned}.
  const n = carriers.length;
  const choice = new Array(n).fill(-1);
  let best = -Infinity;
  const bestSols = [];
  const key = (c, ti) => `${c.id}=${ti >= 0 ? tools[ti].id : '-'}`;
  function value(c) {
    return (scoreByLot.get(c.lot) ?? 0) * c.qty;
  }
  function feasible(c, ti) {
    const t = tools[ti];
    return c.ts >= t.windowStart && c.ts <= t.windowEnd && t.cap >= c.qty;
  }
  function rec(i, used, val) {
    if (i === n) {
      const sol = carriers
        .map((c, k) => key(c, choice[k]))
        .sort()
        .join(',');
      if (val > best) {
        best = val;
        bestSols.length = 0;
        bestSols.push(sol);
      } else if (val === best) {
        bestSols.push(sol);
      }
      return;
    }
    const c = carriers[i];
    for (let ti = 0; ti < tools.length; ti++) {
      if (feasible(c, ti) && used[ti] + c.qty <= tools[ti].cap) {
        choice[i] = ti;
        used[ti] += c.qty;
        rec(i + 1, used, val + value(c));
        used[ti] -= c.qty;
      }
    }
    choice[i] = -1;
    rec(i + 1, used, val);
  }
  rec(0, tools.map(() => 0), 0);
  return { best, sols: new Set(bestSols) };
}

function solverSolKeys(res, carriers) {
  // Same serialization as brute force: "C1=T1,C2=-" sorted by carrier id.
  const keys = new Set();
  for (const s of res.solutions) {
    const map = new Map(s.assignments.map((a) => [a.carrier, a.tool]));
    keys.add(
      carriers
        .map((c) => `${c.id}=${map.get(c.id) ?? '-'}`)
        .sort()
        .join(',')
    );
  }
  return keys;
}

test('acceptance 3: <=6 carriers, solver matches brute-force optimum, ties and budget', () => {
  const tools = [
    { id: 'T1', cap: 7, windowStart: T0, windowEnd: T0 + 2 * H },
    { id: 'T2', cap: 5, windowStart: T0, windowEnd: T0 + H },
    { id: 'T3', cap: 9, windowStart: T0 + H, windowEnd: T0 + 3 * H },
  ];
  const carriers = [
    { id: 'C1', lot: 'L1', qty: 3, ts: T0, due: T0 },
    { id: 'C2', lot: 'L2', qty: 4, ts: T0 + H / 2, due: T0 + H / 2 },
    { id: 'C3', lot: 'L1', qty: 2, ts: T0 + H, due: T0 + H },
    { id: 'C4', lot: 'L3', qty: 5, ts: T0 + H, due: T0 + H },
    { id: 'C5', lot: 'L2', qty: 4, ts: T0 + 2 * H, due: T0 + 2 * H },
    { id: 'C6', lot: 'L4', qty: 1, ts: T0, due: T0 },
  ];
  const scores = new Map([['L1', 5], ['L2', 5], ['L3', 3], ['L4', 0]]);

  const res = solve(carriers, tools, scores);
  const bf = bruteForce(carriers, tools, scores);

  assert.equal(res.objective, bf.best, 'objective must equal brute-force optimum');
  assert.equal(res.tieCount, bf.sols.size, 'tie count must match brute force');
  assert.equal(res.solutions.length, bf.sols.size, 'all tied optima enumerated');

  // Same set of solutions (compared as carrier->tool serializations).
  assert.deepEqual(solverSolKeys(res, carriers), bf.sols);

  // Budget: canonical plan never exceeds cap, remaining >= 0.
  const used = new Map(tools.map((t) => [t.id, 0]));
  for (const a of res.canonical) used.set(a.tool, used.get(a.tool) + a.qty);
  for (const t of tools) {
    assert.ok(used.get(t.id) <= t.cap, `tool ${t.id} over budget`);
    const inPlan = res.canonical.filter((a) => a.tool === t.id).reduce((s, a) => s + a.qty, 0);
    assert.equal(inPlan, used.get(t.id));
  }
});

test('acceptance 4: identical score/due/lot carriers produce every tied solution', () => {
  const tools = [{ id: 'T1', cap: 5, windowStart: T0, windowEnd: T0 + H }];
  const carriers = [
    { id: 'C1', lot: 'L1', qty: 5, ts: T0, due: T0 },
    { id: 'C2', lot: 'L1', qty: 5, ts: T0, due: T0 },
  ];
  const scores = new Map([['L1', 7]]);
  const res = solve(carriers, tools, scores);
  assert.equal(res.objective, 35);
  assert.equal(res.tieCount, 2);
  const sols = res.solutions.map((s) => s.assignments.map((a) => `${a.carrier}->${a.tool}`).join(','));
  assert.ok(sols.includes('C1->T1'));
  assert.ok(sols.includes('C2->T1'));
  // Canonical tie-break: (due, lot, carrier) -> C1 first.
  assert.deepEqual(res.canonical.map((a) => a.carrier), ['C1']);
});

test('window join excludes out-of-window carriers', () => {
  const tools = [{ id: 'T1', cap: 10, windowStart: T0 + H, windowEnd: T0 + 2 * H }];
  const carriers = [{ id: 'C1', lot: 'L1', qty: 1, ts: T0, due: T0 }];
  const res = solve(carriers, tools, new Map([['L1', 9]]));
  assert.equal(res.objective, 0);
  assert.equal(res.canonical.length, 0);
});

test('negative scores are left unassigned', () => {
  const tools = [{ id: 'T1', cap: 10, windowStart: T0, windowEnd: T0 + H }];
  const carriers = [{ id: 'C1', lot: 'L1', qty: 1, ts: T0, due: T0 }];
  const res = solve(carriers, tools, new Map([['L1', -3]]));
  assert.equal(res.objective, 0);
  assert.equal(res.canonicalMap.get('C1'), null);
});
