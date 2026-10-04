import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solve } from '../src/index.js';

const CFG = { peak: 9, capacity: 5, deltaMax: 80, grid: 1, nodeLimit: 1000000, maxSolutions: 1000 };

const good = {
  id: 'good', alloy: 'A', band: [800, 860], mass: 1,
  curve: [{ t: 0, temp: 20 }, { t: 1, temp: 830 }, { t: 2, temp: 830, phase: 'hold' }],
  power: [{ t: 0, power: 3 }, { t: 2, power: 3 }],
};

test('UNSAT 证书：删一批或放宽峰值即满足的极小子集', () => {
  const bad = {
    id: 'bad', alloy: 'A', band: [800, 860], mass: 1,
    curve: [{ t: 0, temp: 20 }, { t: 1, temp: 830 }],
    power: [{ t: 0, power: 10 }, { t: 1, power: 10 }], // 单批即超峰值 9
  };
  const res = solve([good, bad], CFG);
  assert.equal(res.status, 'UNSAT');
  assert.deepEqual(res.certificate.subset, ['bad']);
  assert.ok(Math.abs(res.certificate.relaxPeakTo - 10) <= 1e-9);
  assert.equal(res.certificate.deletionSuffices, true);
  // 删掉该批后确实可行
  assert.equal(solve([good], CFG).status, 'OPTIMAL');
  // 放宽峰值到证书阈值后确实可行
  assert.equal(solve([good, bad], { ...CFG, peak: res.certificate.relaxPeakTo }).status, 'OPTIMAL');
});

test('并列最优全部保留', () => {
  const mk = (id) => ({
    id, alloy: 'A', band: [800, 860], mass: 1,
    curve: [{ t: 0, temp: 20 }, { t: 1, temp: 830 }, { t: 2, temp: 830, phase: 'hold' }],
    power: [{ t: 0, power: 5 }, { t: 2, power: 5 }],
  });
  const res = solve([mk('x'), mk('y')], { ...CFG, peak: 5 });
  assert.equal(res.status, 'OPTIMAL');
  assert.equal(res.objective.makespan, 4);
  assert.equal(res.objective.runCount, 2);
  assert.equal(res.tiesComplete, true);
  assert.equal(res.schedules.length, 2, 'x先y后 / y先x后 两个并列最优');
  const firsts = res.schedules.map((s) => s.runs.find((r) => r.start === 0).batchIds[0]).sort();
  assert.deepEqual(firsts, ['x', 'y']);
});

test('节点预算耗尽时单独表示 UNKNOWN', () => {
  const batches = Array.from({ length: 5 }, (_, i) => ({
    ...good, id: `g${i}`,
  }));
  const res = solve(batches, { ...CFG, nodeLimit: 3 });
  assert.equal(res.status, 'UNKNOWN');
  assert.ok(res.reason.length > 0);
});

test('空批次集合可行：makespan 0、0 炉次', () => {
  const res = solve([], CFG);
  assert.equal(res.status, 'OPTIMAL');
  assert.equal(res.objective.makespan, 0);
  assert.equal(res.objective.runCount, 0);
});

test('装炉量超容量单批即不可行，证书给出该批', () => {
  const heavy = { ...good, id: 'heavy', mass: 6 };
  const res = solve([good, heavy], CFG);
  assert.equal(res.status, 'UNSAT');
  assert.deepEqual(res.certificate.subset, ['heavy']);
});
