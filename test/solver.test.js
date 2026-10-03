import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveSelection, verifyCertificate } from '../src/solver.js';
import { parseRational, add, cmp, fmt, ZERO } from '../src/rational.js';

function makeTasks(specs) {
  const m = new Map();
  for (const s of specs) {
    m.set(s.id, {
      priority: parseRational(s.priority),
      cl: parseRational(s.cost[0]),
      ch: parseRational(s.cost[1]),
      dl: parseRational(s.duration[0]),
      dh: parseRational(s.duration[1]),
      requires: s.requires ?? [],
    });
  }
  return m;
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function randomInstance(rand) {
  const n = 1 + Math.floor(rand() * 9);
  const specs = [];
  const halves = (k) => (k % 2 === 0 ? String(k / 2) : `${k}/2`);
  for (let i = 0; i < n; i++) {
    const cl = Math.floor(rand() * 4);
    const ch = cl + Math.floor(rand() * 3);
    const dl = Math.floor(rand() * 3);
    const dh = dl + Math.floor(rand() * 3);
    const requires = [];
    for (let j = 0; j < i; j++) if (rand() < 0.25) requires.push(`t${j}`);
    specs.push({
      id: `t${i}`,
      priority: halves(Math.floor(rand() * 7)),
      cost: [halves(cl), halves(ch)],
      duration: [halves(dl), halves(dh)],
      requires,
    });
  }
  const budget = halves(Math.floor(rand() * 9));
  const limit = halves(Math.floor(rand() * 7));
  return { tasks: makeTasks(specs), budget: parseRational(budget), limit: parseRational(limit) };
}

function lexCmp(a, b) {
  const m = Math.min(a.length, b.length);
  for (let i = 0; i < m; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

function bruteForce(tasks, budget, limit) {
  const ids = [...tasks.keys()].sort();
  let best = null;
  for (let mask = 0; mask < 1 << ids.length; mask++) {
    const sel = ids.filter((_, i) => (mask >> i) & 1);
    const set = new Set(sel);
    if (!sel.every((id) => tasks.get(id).requires.every((p) => set.has(p)))) continue;
    let p = ZERO, ch = ZERO, dh = ZERO;
    for (const id of sel) {
      const t = tasks.get(id);
      p = add(p, t.priority);
      ch = add(ch, t.ch);
      dh = add(dh, t.dh);
    }
    if (cmp(ch, budget) > 0 || cmp(dh, limit) > 0) continue;
    if (!best || cmp(p, best.p) > 0 || (cmp(p, best.p) === 0 && lexCmp(sel, best.sel) < 0)) {
      best = { sel, p };
    }
  }
  return best;
}

test('acceptance 1: matches brute force over all precedence-filtered subsets for n<=9', () => {
  const rand = lcg(20261003);
  for (let iter = 0; iter < 300; iter++) {
    const { tasks, budget, limit } = randomInstance(rand);
    const expected = bruteForce(tasks, budget, limit);
    const got = solveSelection(tasks, budget, limit);
    assert.equal(got.status, 'ok', `iter ${iter}`);
    assert.deepEqual(got.selected, expected.sel, `iter ${iter} selection`);
    assert.equal(got.prioritySum, fmt(expected.p), `iter ${iter} priority`);
    const v = verifyCertificate(tasks, budget, limit, got.certificate);
    assert.ok(v.valid, `iter ${iter} certificate: ${JSON.stringify(v.checks)}`);
  }
});

test('acceptance 2: worst-case cost exactly equal to budget is accepted', () => {
  const tasks = makeTasks([
    { id: 'a', priority: '1', cost: ['1/2', '3/4'], duration: ['0', '1/2'] },
    { id: 'b', priority: '1', cost: ['0', '1/4'], duration: ['0', '1/2'] },
  ]);
  const res = solveSelection(tasks, parseRational('1'), parseRational('1'));
  assert.equal(res.status, 'ok');
  assert.deepEqual(res.selected, ['a', 'b']);
  assert.deepEqual(res.costInterval, ['1/2', '1']);
  assert.deepEqual(res.durationInterval, ['0', '1']);
  assert.equal(res.prioritySum, '2');
});

test('precedence closure: selecting a successor forces its ancestors', () => {
  const tasks = makeTasks([
    { id: 'base', priority: '0', cost: ['1', '1'], duration: ['0', '0'] },
    { id: 'feat', priority: '5', cost: ['1', '1'], duration: ['0', '0'], requires: ['base'] },
  ]);
  const res = solveSelection(tasks, parseRational('2'), parseRational('0'));
  assert.deepEqual(res.selected, ['base', 'feat']);
  const tight = solveSelection(tasks, parseRational('1'), parseRational('0'));
  assert.deepEqual(tight.selected, []);
  assert.equal(tight.reasons.feat.code, 'budget');
  assert.equal(tight.reasons.base.code, 'tradeoff');
});

test('tie-break: lexicographically smallest id sequence wins', () => {
  const tasks = makeTasks([
    { id: 'b', priority: '1', cost: ['0', '1'], duration: ['0', '0'] },
    { id: 'a', priority: '1', cost: ['0', '1'], duration: ['0', '0'] },
    { id: 'c', priority: '0', cost: ['0', '0'], duration: ['0', '0'] },
  ]);
  const res = solveSelection(tasks, parseRational('1'), parseRational('0'));
  assert.deepEqual(res.selected, ['a']);
  assert.equal(res.reasons.b.code, 'budget');
  assert.equal(res.reasons.c.code, 'tradeoff');
});

test('E_UNSAT when no feasible set exists (negative budget)', () => {
  const tasks = makeTasks([
    { id: 'a', priority: '1', cost: ['0', '0'], duration: ['0', '0'] },
  ]);
  assert.equal(solveSelection(tasks, parseRational('-1'), parseRational('0')).status, 'E_UNSAT');
  assert.equal(solveSelection(tasks, parseRational('0'), parseRational('-1/2')).status, 'E_UNSAT');
});

test('exact interval sums with fractions', () => {
  const tasks = makeTasks([
    { id: 'x', priority: '3/2', cost: ['1/3', '1/2'], duration: ['1/6', '1/4'] },
    { id: 'y', priority: '1/2', cost: ['1/6', '1/2'], duration: ['1/3', '3/4'] },
  ]);
  const res = solveSelection(tasks, parseRational('1'), parseRational('1'));
  assert.deepEqual(res.selected, ['x', 'y']);
  assert.deepEqual(res.costInterval, ['1/2', '1']);
  assert.deepEqual(res.durationInterval, ['1/2', '1']);
  assert.equal(res.prioritySum, '2');
});
