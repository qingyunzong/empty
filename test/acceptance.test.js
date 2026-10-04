import test from 'node:test';
import assert from 'node:assert/strict';
import { solveSchedule, Scheduler, enumerateOptimal } from '../src/index.js';

const CONFIG = {
  peakLimit: 12,
  capacity: 24,
  maxTempDiff: 120,
  alloyGroups: [['A', 'B']],
};

// curve point helper: [t, temp, phase, power]
const pt = (t, temp, phase, power) => ({ t, temp, phase, power });

function sixBatches() {
  return [
    { id: 'b1', alloy: 'A', tempBand: [780, 880], load: 9,  curve: [pt(0, 600, 'heat', 4), pt(2, 840, 'hold', 6), pt(3, 840, 'cool', 2)] },
    { id: 'b2', alloy: 'A', tempBand: [800, 900], load: 8,  curve: [pt(0, 650, 'heat', 3), pt(3, 860, 'hold', 5), pt(4, 860, 'cool', 2)] },
    { id: 'b3', alloy: 'B', tempBand: [790, 870], load: 7,  curve: [pt(0, 620, 'heat', 3), pt(2, 830, 'hold', 4), pt(4, 830, 'cool', 1)] },
    { id: 'b4', alloy: 'B', tempBand: [810, 890], load: 10, curve: [pt(0, 640, 'heat', 5), pt(2, 850, 'hold', 6), pt(3, 850, 'cool', 3)] },
    { id: 'b5', alloy: 'A', tempBand: [800, 880], load: 6,  curve: [pt(0, 610, 'heat', 2), pt(2, 845, 'hold', 5), pt(4, 845, 'cool', 2)] },
    { id: 'b6', alloy: 'B', tempBand: [795, 885], load: 9,  curve: [pt(0, 630, 'heat', 4), pt(3, 855, 'hold', 6), pt(4, 855, 'cool', 2)] },
  ];
}

const canon = (schedules) =>
  schedules
    .map((s) => s.runs.map((r) => `${r.start}:[${r.batches.join('+')}]`).join('|'))
    .sort();

test('acceptance 1: 6 batches match discrete-time enumeration', () => {
  const batches = sixBatches();
  const solved = solveSchedule(batches, CONFIG);
  assert.equal(solved.status, 'OPTIMAL');
  assert.ok(!solved.tiesTruncated);

  const brute = enumerateOptimal(batches, CONFIG, solved.objective.makespan);
  assert.ok(brute.objective, 'brute force found no schedule within solver makespan');
  assert.ok(Math.abs(brute.objective.makespan - solved.objective.makespan) < 1e-9,
    `makespan ${brute.objective.makespan} != ${solved.objective.makespan}`);
  assert.ok(Math.abs(brute.objective.peakValley - solved.objective.peakValley) < 1e-9);
  assert.equal(brute.objective.runs, solved.objective.runs);
  assert.equal(brute.count, solved.schedules.length, 'tied optima count mismatch');
  assert.deepEqual(canon(solved.schedules), canon(brute.schedules));
});

test('acceptance 2: peak exactly equal to demand boundary is feasible', () => {
  const mk = (id) => ({
    id, alloy: 'A', tempBand: [800, 900], load: 5,
    curve: [pt(0, 500, 'heat', 6), pt(2, 850, 'hold', 6)],
  });
  const batches = [mk('x1'), mk('x2')];

  const atBoundary = solveSchedule(batches, { ...CONFIG, peakLimit: 12 });
  assert.equal(atBoundary.status, 'OPTIMAL');
  assert.equal(atBoundary.objective.runs, 1, 'co-fired run with peak == limit must be allowed');
  assert.equal(atBoundary.objective.makespan, 2);
  assert.equal(atBoundary.schedules[0].runs[0].batches.length, 2);

  const below = solveSchedule(batches, { ...CONFIG, peakLimit: 12 - 1e-6 });
  assert.equal(below.status, 'OPTIMAL');
  assert.equal(below.objective.runs, 2, 'epsilon below the boundary must force two runs');
  assert.equal(below.objective.makespan, 4);
});

test('acceptance 3: temp-band edit -> incremental == full re-solve, undo restores', () => {
  const sched = new Scheduler(CONFIG);
  const before = sched.setBatches(sixBatches());
  assert.equal(before.status, 'OPTIMAL');
  const originalB3 = sched.getBatch('b3');

  const incremental = sched.editBatch('b3', { tempBand: [885, 905] });
  assert.equal(incremental.status, 'OPTIMAL');
  assert.ok(incremental.stats.cacheHits > 0, 'incremental solve must reuse cached partitions');

  const edited = sixBatches().map((b) => (b.id === 'b3' ? { ...b, tempBand: [885, 905] } : b));
  const full = solveSchedule(edited, CONFIG);
  assert.equal(full.status, 'OPTIMAL');
  assert.deepEqual(incremental.objective, full.objective);
  assert.deepEqual(canon(incremental.schedules), canon(full.schedules));

  const restored = sched.undo();
  assert.ok(Math.abs(restored.objective.makespan - before.objective.makespan) < 1e-9);
  assert.ok(Math.abs(restored.objective.peakValley - before.objective.peakValley) < 1e-9);
  assert.equal(restored.objective.runs, before.objective.runs);
  assert.deepEqual(canon(restored.schedules), canon(before.schedules));
  assert.deepEqual(sched.getBatch('b3'), originalB3);
});

test('acceptance 4: curve time inversion -> ERR_CURVE, NaN power -> ERR_DOMAIN', () => {
  const base = { id: 'bad', alloy: 'A', tempBand: [800, 900], load: 5 };

  const inverted = solveSchedule(
    [{ ...base, curve: [pt(0, 500, 'heat', 3), pt(3, 800, 'hold', 4), pt(2, 850, 'cool', 2)] }],
    CONFIG
  );
  assert.equal(inverted.status, 'ERROR');
  assert.ok(inverted.errors.some((e) => e.code === 'ERR_CURVE'));

  const nanPower = solveSchedule(
    [{ ...base, curve: [pt(0, 500, 'heat', NaN), pt(2, 850, 'hold', 4)] }],
    CONFIG
  );
  assert.equal(nanPower.status, 'ERROR');
  assert.ok(nanPower.errors.some((e) => e.code === 'ERR_DOMAIN'));

  const negHold = solveSchedule(
    [{ ...base, curve: [pt(0, 800, 'heat', 3), pt(2, 850, 'hold', 4), pt(4, 840, 'cool', 2)] }],
    CONFIG
  );
  assert.equal(negHold.status, 'ERROR');
  assert.ok(negHold.errors.some((e) => e.code === 'ERR_CURVE' && e.message.includes('hold')));
});

test('UNSAT certificate: remove-one or relaxed-peak subset', () => {
  const batches = [
    ...sixBatches().slice(0, 2),
    { id: 'bBad', alloy: 'A', tempBand: [800, 900], load: 5, curve: [pt(0, 500, 'heat', 15), pt(2, 850, 'hold', 15)] },
  ];
  const res = solveSchedule(batches, CONFIG);
  assert.equal(res.status, 'UNSAT');
  assert.deepEqual(res.certificate.subset, ['bBad']);
  assert.equal(res.certificate.removal.bBad, 'FEASIBLE');
  assert.ok(Math.abs(res.certificate.relaxedPeak - 15) < 1e-9);

  const heavy = [
    ...sixBatches().slice(0, 2),
    { id: 'bHeavy', alloy: 'A', tempBand: [800, 900], load: 30, curve: [pt(0, 500, 'heat', 3), pt(2, 850, 'hold', 3)] },
  ];
  const res2 = solveSchedule(heavy, CONFIG);
  assert.equal(res2.status, 'UNSAT');
  assert.deepEqual(res2.certificate.subset, ['bHeavy']);
  assert.equal(res2.certificate.removal.bHeavy, 'FEASIBLE');
  assert.equal(res2.certificate.relaxedPeak, null, 'load violation cannot be fixed by relaxing peak');
});

test('UNKNOWN is reported separately when the node budget is exhausted', () => {
  const res = solveSchedule(sixBatches(), CONFIG, { nodeBudget: 1 });
  assert.equal(res.status, 'UNKNOWN');
  assert.notEqual(res.status, 'UNSAT');
  assert.equal(res.certificate, undefined);
});

test('tied optima are all preserved', () => {
  const mk = (id) => ({
    id, alloy: 'A', tempBand: [800, 900], load: 5,
    curve: [pt(0, 500, 'heat', 5), pt(2, 850, 'hold', 5)],
  });
  const res = solveSchedule([mk('p'), mk('q')], { ...CONFIG, peakLimit: 5, capacity: 5 });
  assert.equal(res.status, 'OPTIMAL');
  assert.equal(res.objective.makespan, 4);
  assert.equal(res.schedules.length, 2, 'both sequential orders are tied optima');
  const keys = canon(res.schedules);
  assert.notEqual(keys[0], keys[1]);
});
