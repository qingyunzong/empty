'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scheduleExact, schedule } = require('../src/scheduler');
const { prng } = require('./helpers');

// Independent brute force: enumerate every assignment of packages to workers
// (or skip) and every per-worker permutation; return the best achievable
// (boostedScheduled, onTime) lexicographic score.
function bruteForce(pkgs, workers, startTimes) {
  let best = [0, 0];
  const assign = new Array(pkgs.length).fill(-1);
  const subsetCache = new Map();

  // Best (boosted, onTime) achievable by one worker for a given subset mask,
  // enumerating every permutation of the subset in place.
  function bestForSubset(w, mask) {
    const key = w + ':' + mask;
    if (subsetCache.has(key)) return subsetCache.get(key);
    const idxs = [];
    for (let i = 0; i < pkgs.length; i += 1) {
      if (mask & (1 << i)) idxs.push(i);
    }
    const wBest = [0, 0];
    (function rec(pos, t, b, o) {
      if (pos === idxs.length) {
        if (b > wBest[0] || (b === wBest[0] && o > wBest[1])) {
          wBest[0] = b;
          wBest[1] = o;
        }
        return;
      }
      for (let i = pos; i < idxs.length; i += 1) {
        const tmp = idxs[pos];
        idxs[pos] = idxs[i];
        idxs[i] = tmp;
        const p = pkgs[idxs[pos]];
        const nt = t + Math.ceil(p.size / workers[w].throughput);
        rec(pos + 1, nt, b + (p.boosted ? 1 : 0), o + (nt <= p.deadline ? 1 : 0));
        idxs[i] = idxs[pos];
        idxs[pos] = tmp;
      }
    }(0, startTimes[w], 0, 0));
    subsetCache.set(key, wBest);
    return wBest;
  }

  function evaluate() {
    let boosted = 0;
    let onTime = 0;
    for (let w = 0; w < workers.length; w += 1) {
      let mask = 0;
      for (let i = 0; i < pkgs.length; i += 1) {
        if (assign[i] === w && workers[w].maxLevel >= pkgs[i].level) mask |= 1 << i;
      }
      const wBest = bestForSubset(w, mask);
      boosted += wBest[0];
      onTime += wBest[1];
    }
    const score = [boosted, onTime];
    if (score[0] > best[0] || (score[0] === best[0] && score[1] > best[1])) best = score;
  }

  function rec(i) {
    if (i === pkgs.length) { evaluate(); return; }
    for (let w = -1; w < workers.length; w += 1) {
      assign[i] = w;
      rec(i + 1);
    }
    assign[i] = -1;
  }
  rec(0);
  return best;
}

test('exact scheduler matches brute-force optimum on small sets (n<=9)', () => {
  const rand = prng(20261003);
  let cases = 0;
  for (let iter = 0; iter < 40; iter += 1) {
    const n = 2 + Math.floor(rand() * 6); // 2..7
    const wCount = 1 + Math.floor(rand() * 2); // 1..2
    const workers = [];
    for (let w = 0; w < wCount; w += 1) {
      workers.push({
        id: `w${w}`,
        throughput: 1 + Math.floor(rand() * 2),
        maxLevel: 1 + Math.floor(rand() * 3),
      });
    }
    const pkgs = [];
    for (let i = 0; i < n; i += 1) {
      pkgs.push({
        id: `p${i}`,
        size: 1 + Math.floor(rand() * 5),
        level: 1 + Math.floor(rand() * 3),
        deadline: 1 + Math.floor(rand() * 12),
        boosted: rand() < 0.25,
      });
    }
    const startTimes = {};
    for (const w of workers) startTimes[w.id] = Math.floor(rand() * 3);
    const got = scheduleExact(pkgs, workers, startTimes);
    const [wantBoosted, wantOnTime] = bruteForce(pkgs, workers, workers.map((w) => startTimes[w.id]));
    assert.equal(got.boostedScheduled, wantBoosted, `boosted mismatch: ${JSON.stringify({ pkgs, workers, startTimes })}`);
    assert.equal(got.onTime, wantOnTime, `onTime mismatch: ${JSON.stringify({ pkgs, workers, startTimes })}`);
    cases += 1;
  }
  assert.ok(cases >= 40);
});

test('exact scheduler is deterministic', () => {
  const rand = prng(7);
  const pkgs = [];
  for (let i = 0; i < 8; i += 1) {
    pkgs.push({
      id: `p${i}`,
      size: 1 + Math.floor(rand() * 5),
      level: 1 + Math.floor(rand() * 2),
      deadline: 1 + Math.floor(rand() * 10),
      boosted: false,
    });
  }
  const workers = [
    { id: 'w1', throughput: 1, maxLevel: 1 },
    { id: 'w2', throughput: 2, maxLevel: 2 },
  ];
  const a = scheduleExact(pkgs, workers, { w1: 0, w2: 0 });
  const b = scheduleExact(pkgs, workers, { w1: 0, w2: 0 });
  assert.deepEqual([...a.assignments.entries()], [...b.assignments.entries()]);
});

test('boost never breaks the security-level constraint', () => {
  const pkgs = [
    { id: 'high', size: 2, level: 3, deadline: 100, boosted: true },
    { id: 'low', size: 2, level: 1, deadline: 100, boosted: false },
  ];
  const workers = [{ id: 'w1', throughput: 1, maxLevel: 1 }];
  const r = scheduleExact(pkgs, workers, { w1: 0 });
  assert.equal(r.assignments.has('high'), false, 'boosted package must not land on an ineligible worker');
  assert.equal(r.assignments.has('low'), true);
});

test('schedule() falls back for large batches and respects levels', () => {
  const pkgs = [];
  for (let i = 0; i < 30; i += 1) {
    pkgs.push({ id: `p${i}`, size: 3, level: (i % 3) + 1, deadline: 50, boosted: i === 29 });
  }
  const workers = [
    { id: 'w1', throughput: 1, maxLevel: 1 },
    { id: 'w2', throughput: 2, maxLevel: 3 },
  ];
  const r = schedule(pkgs, workers, { w1: 0, w2: 0 });
  for (const a of r.assignments.values()) {
    const pkg = pkgs.find((p) => p.id === a.pkgId);
    const wk = workers.find((w) => w.id === a.workerId);
    assert.ok(wk.maxLevel >= pkg.level);
  }
  assert.equal(r.assignments.has('p29'), true, 'boosted package is scheduled first');
});

test('exact scheduler matches brute force at n=8 (2 workers) and n=9 (1 worker)', () => {
  const rand = prng(99);
  // n=8, two workers with different levels and throughputs
  for (let iter = 0; iter < 2; iter += 1) {
    const workers = [
      { id: 'w1', throughput: 1 + Math.floor(rand() * 2), maxLevel: 1 + Math.floor(rand() * 2) },
      { id: 'w2', throughput: 1 + Math.floor(rand() * 2), maxLevel: 2 + Math.floor(rand() * 2) },
    ];
    const pkgs = [];
    for (let i = 0; i < 8; i += 1) {
      pkgs.push({
        id: `p${i}`,
        size: 1 + Math.floor(rand() * 4),
        level: 1 + Math.floor(rand() * 3),
        deadline: 2 + Math.floor(rand() * 10),
        boosted: rand() < 0.2,
      });
    }
    const starts = { w1: Math.floor(rand() * 2), w2: Math.floor(rand() * 2) };
    const got = scheduleExact(pkgs, workers, starts);
    const [wb, wo] = bruteForce(pkgs, workers, [starts.w1, starts.w2]);
    assert.equal(got.boostedScheduled, wb, `boosted mismatch ${JSON.stringify({ pkgs, workers, starts })}`);
    assert.equal(got.onTime, wo, `onTime mismatch ${JSON.stringify({ pkgs, workers, starts })}`);
  }
  // n=9, single worker
  for (let iter = 0; iter < 2; iter += 1) {
    const workers = [{ id: 'w1', throughput: 1 + Math.floor(rand() * 2), maxLevel: 3 }];
    const pkgs = [];
    for (let i = 0; i < 9; i += 1) {
      pkgs.push({
        id: `p${i}`,
        size: 1 + Math.floor(rand() * 4),
        level: 1 + Math.floor(rand() * 3),
        deadline: 2 + Math.floor(rand() * 12),
        boosted: rand() < 0.2,
      });
    }
    const got = scheduleExact(pkgs, workers, { w1: 0 });
    const [wb, wo] = bruteForce(pkgs, workers, [0]);
    assert.equal(got.boostedScheduled, wb, `boosted mismatch ${JSON.stringify({ pkgs, workers })}`);
    assert.equal(got.onTime, wo, `onTime mismatch ${JSON.stringify({ pkgs, workers })}`);
  }
});
