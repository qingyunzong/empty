'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeSchedule, fairCompare, txLenFor } = require('../src/scheduler');
const { mulberry32 } = require('./helpers');

function mkPass(id, taskId, start, end, rate, onboard, extra = {}) {
  return {
    id, taskId, rate, onboard,
    window: { start, end },
    drop: null, confirmed: null,
    ...extra,
  };
}

function mkState(passes, tasks = {}, setup = 0) {
  const passMap = {};
  for (const p of passes) passMap[p.id] = p;
  return { config: { setup, maxRate: 1e9 }, tasks, passes: passMap };
}

// Brute-force optimum over all subsets (feasibility mirrors the scheduler:
// sorted by start, next.start >= prev.start + prev.txLen + setup).
function bruteForce(passes, setup) {
  const cand = passes
    .filter((p) => !p.drop && !(p.confirmed && p.confirmed.bytes > 0))
    .map((p) => {
      const len = p.window.end - p.window.start;
      const potential = Math.max(0, Math.min(p.rate * len, p.onboard));
      return { start: p.window.start, potential, txLen: txLenFor(potential, p.rate) };
    })
    .filter((c) => c.potential > 0)
    .sort((a, b) => a.start - b.start);
  const n = cand.length;
  let best = 0;
  for (let mask = 0; mask < (1 << n); mask++) {
    let prevEnd = -Infinity;
    let total = 0;
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      if (!(mask & (1 << i))) continue;
      const c = cand[i];
      if (c.start < prevEnd + setup) { ok = false; break; }
      prevEnd = c.start + c.txLen;
      total += c.potential;
    }
    if (ok && total > best) best = total;
  }
  return best;
}

test('acceptance 1: scheduler matches brute-force max effective bytes for n<=12', () => {
  const rand = mulberry32(20261003);
  for (let iter = 0; iter < 60; iter++) {
    const n = 1 + Math.floor(rand() * 12);
    const setup = Math.floor(rand() * 6);
    const passes = [];
    for (let i = 0; i < n; i++) {
      const start = Math.floor(rand() * 120);
      const end = start + 1 + Math.floor(rand() * 40);
      const rate = 1 + Math.floor(rand() * 10);
      const onboard = rand() < 0.3 ? Math.floor(rand() * 50) : 1e9;
      passes.push(mkPass(`p${i}`, `t${i % 3}`, start, end, rate, onboard));
    }
    const result = computeSchedule(mkState(passes, {}, setup));
    const optimum = bruteForce(passes, setup);
    assert.equal(result.totalBytes, optimum,
      `iter ${iter}: n=${n} setup=${setup} got ${result.totalBytes} want ${optimum}`);
  }
});

test('acceptance 3: equal deficit ties break by taskId then start second', () => {
  // Two fully overlapping identical passes, different tasks, equal deficit.
  const passes = [
    mkPass('pB', 'taskB', 0, 100, 10, 1e9),
    mkPass('pA', 'taskA', 0, 100, 10, 1e9),
  ];
  const tasks = { taskA: { min: 500 }, taskB: { min: 500 } };
  const r1 = computeSchedule(mkState(passes, tasks));
  assert.ok(r1.assignments.pA, 'taskA wins on smaller taskId');
  assert.ok(!r1.assignments.pB);

  // Same task, two overlapping passes with different starts: earlier wins.
  const passes2 = [
    mkPass('pLate', 'taskA', 50, 150, 10, 1e9),
    mkPass('pEarly', 'taskA', 0, 100, 10, 1e9),
  ];
  const r2 = computeSchedule(mkState(passes2, { taskA: {} }));
  assert.ok(r2.assignments.pEarly, 'earlier start wins for same task');
  assert.ok(!r2.assignments.pLate);

  // fairCompare ordering: deficit desc, taskId asc, start asc.
  const deficits = { a: 10, b: 10, c: 50 };
  const list = [
    { id: 'p1', taskId: 'b', start: 5 },
    { id: 'p2', taskId: 'a', start: 9 },
    { id: 'p3', taskId: 'c', start: 1 },
    { id: 'p4', taskId: 'a', start: 2 },
  ].sort((x, y) => fairCompare(x, y, deficits));
  assert.deepEqual(list.map((p) => p.id), ['p3', 'p4', 'p2', 'p1']);
});

test('deficit preference: task with larger unmet guarantee wins equal-byte conflicts', () => {
  const passes = [
    mkPass('pLow', 'low', 0, 100, 10, 1e9),
    mkPass('pHigh', 'high', 0, 100, 10, 1e9),
  ];
  // taskIds chosen so plain taskId tie-break would pick 'high' anyway only
  // if deficit did not matter; give 'low' the smaller id but zero deficit.
  const tasks = { high: { min: 900 }, low: { min: 0 } };
  const r = computeSchedule(mkState(passes, tasks));
  assert.ok(r.assignments.pHigh, 'larger deficit wins');
  assert.ok(!r.assignments.pLow);
});

test('switch setup time separates consecutive transmissions', () => {
  const passes = [
    mkPass('p1', 't1', 0, 10, 1, 1e9),
    mkPass('p2', 't2', 12, 22, 1, 1e9),
  ];
  const r5 = computeSchedule(mkState(passes, {}, 5));
  assert.equal(r5.totalBytes, 10, 'gap of 2 < setup 5: only one pass fits');
  const r2 = computeSchedule(mkState(passes, {}, 2));
  assert.equal(r2.totalBytes, 20, 'gap of 2 >= setup 2: both fit');
});

test('preemption preserves confirmed bytes and only uses unlocked segments', () => {
  const confirmed = mkPass('pC', 't1', 0, 100, 10, 1e9, {
    confirmed: { start: 0, txLen: 50, bytes: 500 },
  });
  const other = mkPass('pO', 't2', 40, 100, 10, 1e9); // overlaps locked [0,50)
  const free = mkPass('pF', 't3', 60, 100, 10, 1e9); // clear of locked segment
  const r = computeSchedule(mkState([confirmed, other, free], {}, 5));
  assert.equal(r.assignments.pC.bytes, 500, 'confirmed bytes preserved');
  assert.equal(r.assignments.pC.locked, true);
  assert.ok(!r.assignments.pO, 'overlapping pass preempted out (conflict loss)');
  assert.ok(r.assignments.pF, 'unlocked segment still schedulable');
  assert.equal(r.loss.byPass.pO.reason, 'conflict');
});

test('quota caps allocation and attributes loss to quota', () => {
  const passes = [mkPass('p1', 't1', 0, 100, 10, 1e9)];
  const r = computeSchedule(mkState(passes, { t1: { quota: 400 } }));
  assert.equal(r.assignments.p1.bytes, 400);
  assert.equal(r.loss.quota, 600);
  assert.equal(r.loss.byPass.p1.reason, 'quota');
});

test('drop reasons distinguish weather/conflict/quota; pending weather not a failure', () => {
  const passes = [
    mkPass('pW', 't1', 0, 100, 10, 1e9, { drop: { reason: 'weather', pending: false } }),
    mkPass('pP', 't2', 0, 100, 10, 1e9, { drop: { reason: 'weather', pending: true } }),
    mkPass('pQ', 't3', 0, 100, 10, 1e9, { drop: { reason: 'quota', pending: false } }),
    mkPass('pC', 't4', 0, 100, 10, 1e9, { drop: { reason: 'conflict', pending: false } }),
  ];
  const r = computeSchedule(mkState(passes, {}));
  assert.equal(r.loss.weather, 1000);
  assert.equal(r.loss.pending, 1000);
  assert.equal(r.loss.quota, 1000);
  assert.equal(r.loss.conflict, 1000);
  assert.equal(r.totalBytes, 0);
});
