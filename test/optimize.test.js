import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optimizeShed } from '../src/optimize.js';

// Independent brute-force reference used to cross-check the optimizer.
function bruteForce(windows, loads, budget) {
  const perWindow = windows.map(() => {
    const opts = [];
    const n = loads.length;
    for (let mask = 0; mask < 1 << n; mask++) {
      let kw = 0;
      const picks = [];
      for (let i = 0; i < n; i++) {
        if (mask & (1 << i)) {
          kw += loads[i].kw;
          picks.push(loads[i].load);
        }
      }
      if (kw <= budget + 1e-9) opts.push({ kw, loads: picks });
    }
    return opts;
  });
  let bestCost = Infinity;
  let bestShed = Infinity;
  let ties = [];
  const chosen = new Array(windows.length);
  const walk = (d, shed) => {
    if (d === windows.length) {
      let cost = 0;
      for (let i = 0; i < windows.length; i++) {
        cost = Math.max(cost, (windows[i].baselineKw - chosen[i].kw) * windows[i].rate);
      }
      if (cost < bestCost - 1e-9 || (Math.abs(cost - bestCost) <= 1e-9 && shed < bestShed - 1e-9)) {
        bestCost = cost;
        bestShed = shed;
        ties = [chosen.map((c) => [...c.loads])];
      } else if (Math.abs(cost - bestCost) <= 1e-9 && Math.abs(shed - bestShed) <= 1e-9) {
        ties.push(chosen.map((c) => [...c.loads]));
      }
      return;
    }
    for (const o of perWindow[d]) {
      chosen[d] = o;
      walk(d + 1, shed + o.kw);
    }
  };
  walk(0, 0);
  return { cost: bestCost, shed: bestShed, ties };
}

test('acceptance 3a: tied optimal plans are all reported, load-lexicographic order', () => {
  const windows = [{ windowStart: 0, baselineKw: 100, rate: 1 }];
  const loads = [
    { load: 'A', kw: 10 },
    { load: 'B', kw: 10 },
  ];
  const r = optimizeShed(windows, loads, 10);
  assert.equal(r.method, 'exhaustive');
  assert.equal(r.cost, 90);
  assert.equal(r.totalShedKw, 10);
  assert.equal(r.plans.length, 2);
  assert.deepEqual(
    r.plans.map((p) => p[0].loads),
    [['A'], ['B']],
  );
});

test('acceptance 3b: <=3 windows exhaustive result matches independent brute force', () => {
  const windows = [
    { windowStart: 0, baselineKw: 100, rate: 1 },
    { windowStart: 900000, baselineKw: 90, rate: 2 },
    { windowStart: 1800000, baselineKw: 80, rate: 1 },
  ];
  const loads = [
    { load: 'A', kw: 10 },
    { load: 'B', kw: 20 },
    { load: 'C', kw: 5 },
  ];
  const budget = 25;
  const r = optimizeShed(windows, loads, budget);
  assert.equal(r.method, 'exhaustive');
  const ref = bruteForce(windows, loads, budget);
  assert.ok(Math.abs(r.cost - ref.cost) <= 1e-9);
  assert.ok(Math.abs(r.totalShedKw - ref.shed) <= 1e-9);
  const got = r.plans.map((p) => p.map((w) => w.loads));
  const want = ref.ties.map((t) => t);
  const sortKey = (plans) => [...plans].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert.deepEqual(sortKey(got), sortKey(want));
  // plans are emitted in load-lexicographic order
  const keys = got.map((p) => JSON.stringify(p));
  assert.deepEqual(keys, [...keys].sort());
});

test('budget caps sheddable kW per window', () => {
  const windows = [{ windowStart: 0, baselineKw: 100, rate: 5 }];
  const loads = [
    { load: 'A', kw: 30 },
    { load: 'B', kw: 30 },
  ];
  const r = optimizeShed(windows, loads, 30);
  assert.equal(r.cost, 350); // can only shed 30 of the 60 available
  assert.equal(r.totalShedKw, 30);
  assert.equal(r.plans.length, 2); // {A} and {B} tie
});

test('zero rate window never gets shed', () => {
  const windows = [
    { windowStart: 0, baselineKw: 100, rate: 0 },
    { windowStart: 900000, baselineKw: 50, rate: 3 },
  ];
  const loads = [{ load: 'A', kw: 10 }];
  const r = optimizeShed(windows, loads, Infinity);
  assert.equal(r.cost, 120);
  assert.equal(r.totalShedKw, 10);
  assert.deepEqual(r.plans[0][0].loads, []);
  assert.deepEqual(r.plans[0][1].loads, ['A']);
});

test('empty input yields a trivial empty plan', () => {
  const r = optimizeShed([], [], Infinity);
  assert.equal(r.cost, 0);
  assert.deepEqual(r.plans, [[]]);
});
