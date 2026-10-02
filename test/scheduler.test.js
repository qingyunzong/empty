import test from 'node:test';
import assert from 'node:assert/strict';
import { intervalJoin, simulate, schedule } from '../src/scheduler.js';
import {
  CHANGEOVER_MS,
  UNIT_PROCESS_MS,
  CHANGEOVER_ENERGY_TENTHS,
  UNIT_ENERGY_TENTHS,
} from '../src/constants.js';

const T0 = Date.UTC(2026, 9, 2, 14, 0, 0); // 22:00 Asia/Shanghai, night shift start
const H = 3600 * 1000;
const M = 60 * 1000;

const order = (job, mold, qty, opts = {}) => ({
  type: 'order',
  arriveTs: opts.arriveTs ?? T0,
  eventTs: opts.eventTs ?? T0,
  job,
  mold,
  due: opts.due ?? T0 + 8 * H,
  qty,
  op: 'add',
});

test('intervalJoin pairs overlapping half-open intervals only', () => {
  const as = [{ start: 0, end: 10 }, { start: 20, end: 30 }];
  const bs = [{ start: 5, end: 7 }, { start: 10, end: 20 }, { start: 25, end: 35 }];
  const pairs = intervalJoin(as, bs);
  assert.equal(pairs.length, 2);
  assert.deepEqual(pairs.map((p) => [p.a.start, p.b.start]), [[0, 5], [20, 25]]);
});

test('simulate shifts a job block past a maintenance window', () => {
  const jobs = [order('A', 'M1', 30)];
  const maints = [{ type: 'maint', eventTs: T0, machine: 'L1', start: T0, end: T0 + 2 * H, op: 'add', id: 'm1' }];
  const run = simulate(jobs, maints, T0);
  assert.equal(run.entries[0].start, T0 + 2 * H);
  assert.equal(run.entries[0].end, T0 + 2 * H + 30 * M);
});

test('simulate charges changeover time and energy on mold switch', () => {
  const jobs = [order('A', 'M1', 10), order('B', 'M2', 10)];
  const run = simulate(jobs, [], T0);
  assert.equal(run.entries[1].start, T0 + 10 * M); // block start includes the changeover
  assert.equal(run.entries[1].changeoverEnd, T0 + 10 * M + CHANGEOVER_MS);
  assert.equal(run.energyTenths, CHANGEOVER_ENERGY_TENTHS + 20 * UNIT_ENERGY_TENTHS);
});

test('tied optima: all best sequences are emitted in job lexicographic order', () => {
  const jobs = [order('J1', 'X', 10), order('J2', 'X', 10), order('J3', 'Y', 10)];
  const r = schedule(jobs, [], T0);
  assert.equal(r.objective.violations, 0);
  assert.deepEqual(
    r.sequences.map((s) => s.map((e) => e.job)),
    [
      ['J1', 'J2', 'J3'],
      ['J2', 'J1', 'J3'],
      ['J3', 'J1', 'J2'],
      ['J3', 'J2', 'J1'],
    ],
  );
});

// Acceptance 3: independent brute-force reference for all small cases (<=8 jobs).
function refPermutations(arr) {
  if (arr.length <= 1) return [arr.slice()];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of refPermutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

function refScore(perm, maints) {
  let t = T0;
  let prev = null;
  let violations = 0;
  let energyTenths = 0;
  for (const j of perm) {
    t = Math.max(t, j.eventTs);
    const co = prev !== null && prev !== j.mold ? CHANGEOVER_MS : 0;
    const proc = j.qty * UNIT_PROCESS_MS;
    let s = t;
    for (;;) {
      const hit = maints.find((m) => m.start < s + co + proc && s < m.end);
      if (!hit) break;
      s = hit.end;
    }
    const end = s + co + proc;
    if (end > j.due) violations += 1;
    energyTenths += (co ? CHANGEOVER_ENERGY_TENTHS : 0) + j.qty * UNIT_ENERGY_TENTHS;
    t = end;
    prev = j.mold;
  }
  return { violations, makespan: t, energyTenths };
}

function refBest(jobs, maints) {
  let bestKey = null;
  let tied = [];
  for (const perm of refPermutations(jobs)) {
    const s = refScore(perm, maints);
    const key = [s.violations, s.makespan, s.energyTenths];
    const cmp = bestKey === null ? -1 : key[0] - bestKey[0] || key[1] - bestKey[1] || key[2] - bestKey[2];
    if (cmp < 0) {
      bestKey = key;
      tied = [perm.map((j) => j.job).join(',')];
    } else if (cmp === 0) {
      tied.push(perm.map((j) => j.job).join(','));
    }
  }
  tied.sort();
  return { key: bestKey, tied };
}

test('exhaustive cross-check against brute force for 1..8 jobs', () => {
  for (let n = 1; n <= 8; n++) {
    const molds = ['X', 'Y', 'Z'];
    const jobs = Array.from({ length: n }, (_, i) =>
      order(`J${i}`, molds[i % 3], ((i % 3) + 1) * 10, { due: T0 + 8 * H }),
    );
    const maints =
      n % 2 === 0
        ? [{ type: 'maint', eventTs: T0, machine: 'L1', start: T0 + 30 * M, end: T0 + 50 * M, op: 'add', id: 'mx' }]
        : [];
    const lib = schedule(jobs, maints, T0);
    const ref = refBest(jobs, maints);
    assert.deepEqual(
      [lib.objective.violations, lib.objective.makespan, Math.round(lib.objective.energy * 10)],
      ref.key,
      `objective mismatch for n=${n}`,
    );
    assert.deepEqual(
      lib.sequences.map((s) => s.map((e) => e.job).join(',')),
      ref.tied,
      `tied set mismatch for n=${n}`,
    );
  }
});

test('due violations are minimized before makespan and energy', () => {
  const jobs = [order('A', 'M1', 60, { due: T0 + 30 * M }), order('B', 'M1', 10)];
  const r = schedule(jobs, [], T0);
  assert.equal(r.objective.violations, 1);
});
