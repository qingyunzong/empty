import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveSchedule } from '../src/solver.js';

function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

function feasibleSet(sel, fixed, quotas) {
  const acts = [
    ...fixed.map((f) => ({ start: f.start, end: f.end, switch: f.switch ?? 0 })),
    ...sel.map((c) => ({ start: c.start, end: c.end, switch: c.switch ?? 0 })),
  ].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 0; i + 1 < acts.length; i++) {
    if (acts[i].end + acts[i + 1].switch > acts[i + 1].start) return false;
  }
  const exp = {};
  for (const f of fixed) exp[f.pi] = (exp[f.pi] ?? 0) + (f.end - f.start);
  for (const c of sel) exp[c.pi] = (exp[c.pi] ?? 0) + (c.end - c.start);
  for (const [pi, q] of quotas) if ((exp[pi] ?? 0) > q) return false;
  return true;
}

function bruteForceMaxValue(candidates, fixed, quotas) {
  let best = 0;
  const n = candidates.length;
  for (let mask = 0; mask < 1 << n; mask++) {
    const sel = candidates.filter((_, i) => mask & (1 << i));
    if (!feasibleSet(sel, fixed, quotas)) continue;
    const v = sel.reduce((a, c) => a + c.value, 0);
    if (v > best) best = v;
  }
  return best;
}

// Acceptance 1: n <= 10 matches brute-force enumeration of max value.
test('solver max value matches brute-force enumeration for n<=10', () => {
  const rand = lcg(20261003);
  for (let trial = 0; trial < 300; trial++) {
    const n = 1 + Math.floor(rand() * 10);
    const pis = ['p1', 'p2', 'p3'];
    const candidates = [];
    for (let i = 0; i < n; i++) {
      const start = Math.floor(rand() * 40);
      const dur = 1 + Math.floor(rand() * 8);
      candidates.push({
        id: `T${i}`,
        pi: pis[Math.floor(rand() * 3)],
        start,
        end: start + dur,
        value: 1 + Math.floor(rand() * 20),
        switch: Math.floor(rand() * 4),
      });
    }
    const quotas = new Map();
    for (const p of pis) quotas.set(p, rand() < 0.5 ? Infinity : 5 + Math.floor(rand() * 20));
    const fixed = [{ id: 'O0', target: 'FX', pi: 'p1', start: 15, end: 19, switch: 2 }];
    const sol = solveSchedule({ candidates, fixed, quotas, pis });
    const bf = bruteForceMaxValue(candidates, fixed, quotas);
    assert.equal(sol.value, bf, `trial ${trial}: solver=${sol.value} brute=${bf}`);
  }
});

test('fairness minimizes max PI exposure deficit among max-value schedules', () => {
  const candidates = [
    { id: 'A1', pi: 'A', start: 0, end: 10, value: 10, switch: 0 },
    { id: 'B1', pi: 'B', start: 0, end: 10, value: 10, switch: 0 },
    { id: 'A2', pi: 'A', start: 20, end: 25, value: 1, switch: 0 },
    { id: 'B2', pi: 'B', start: 20, end: 25, value: 1, switch: 0 },
  ];
  const sol = solveSchedule({ candidates, fixed: [], quotas: new Map(), pis: ['A', 'B'] });
  assert.equal(sol.value, 11);
  assert.equal(sol.maxDeficit, 5);
  assert.deepEqual(sol.selected.map((s) => s.id).sort(), ['A1', 'B2']);
});

test('switch cost can block an otherwise feasible pair', () => {
  // Without switch cost X->Y would fit (10 <= 12); with switch 5 it does not.
  const candidates = [
    { id: 'X', pi: 'p', start: 0, end: 10, value: 7, switch: 0 },
    { id: 'Y', pi: 'p', start: 12, end: 20, value: 6, switch: 5 },
  ];
  const sol = solveSchedule({ candidates, fixed: [], quotas: new Map(), pis: ['p'] });
  assert.deepEqual(sol.selected.map((s) => s.id), ['X']);
  assert.equal(sol.value, 7);
});
