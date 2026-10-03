import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveSite, genPatterns } from '../src/scheduler.js';
import { bruteForce } from '../src/reference.js';
import { mulberry32 } from './helpers.js';

function randomSite(rng, nTasks) {
  const slots = 4 + Math.floor(rng() * 5);
  const slotMinutes = 15;
  const priceMicro = Array.from({ length: slots }, () => Math.floor(rng() * 4) * 1e6);
  const carbonMicro = Array.from({ length: slots }, () => Math.floor(rng() * 3) * 1e6);
  const blocked = new Uint8Array(slots);
  if (rng() < 0.4) blocked[Math.floor(rng() * slots)] = 1;
  const tasks = [];
  for (let k = 0; k < nTasks; k += 1) {
    const durationSlots = 1 + Math.floor(rng() * 2);
    let winStart = Math.floor(rng() * slots);
    let winEnd = winStart + 1 + Math.floor(rng() * (slots - winStart));
    if (rng() < 0.2) winEnd = Math.min(slots, winStart + durationSlots);
    const interruptible = rng() < 0.3;
    const after = [];
    if (k > 0 && rng() < 0.3) after.push(`t${Math.floor(rng() * k)}`);
    tasks.push({
      id: `t${k}`,
      watts: 1000 * (1 + Math.floor(rng() * 3)),
      durationSlots,
      winStart,
      winEnd,
      interruptible,
      maxInterrupts: interruptible ? 1 : null,
      after,
      before: [],
    });
  }
  const site = {
    name: 'R',
    slots,
    slotMinutes,
    priceMicro,
    carbonMicro,
    costBudget: null,
    carbonBudget: null,
    peakLimitW: rng() < 0.3 ? 1000 * (2 + Math.floor(rng() * 3)) : null,
    blocked,
    maintenanceRanges: [],
    tasks,
    objective: { kind: 'var', name: 'cost' },
  };
  if (rng() < 0.3) site.costBudget = Math.floor(rng() * 3);
  if (rng() < 0.3) site.carbonBudget = Math.floor(rng() * 3);
  return site;
}

function combinationCount(site) {
  return site.tasks.reduce((acc, t) => acc * Math.max(1, genPatterns(t, site).length), 1);
}

function assertSameResult(site) {
  const expected = bruteForce(site);
  const actual = solveSite(site);
  assert.equal(actual.status, expected.status, `status mismatch for ${JSON.stringify(site.tasks.map((t) => t.id))}`);
  assert.deepEqual(actual.budgetsExceeded, expected.budgetsExceeded);
  if (expected.optimum) {
    assert.equal(actual.optimum.costNum, expected.optimum.costNum);
    assert.equal(actual.optimum.carbonNum, expected.optimum.carbonNum);
    assert.equal(actual.optimum.peakW, expected.optimum.peakW);
    assert.equal(actual.optimum.signature, expected.optimum.signature);
    assert.equal(actual.optimum.detailKey, expected.optimum.detailKey);
    assert.equal(actual.optimum.objectiveValue, expected.optimum.objectiveValue);
  }
}

test('scheduler matches brute-force reference on random sites with up to 8 tasks', () => {
  const rng = mulberry32(20261004);
  let tested = 0;
  let tested8 = 0;
  let infeasible = 0;
  let overBudget = 0;
  for (let i = 0; i < 400 && (tested < 30 || tested8 < 3); i += 1) {
    const nTasks = tested8 < 3 && i % 10 === 9 ? 8 : 2 + Math.floor(rng() * 5);
    const site = randomSite(rng, nTasks);
    if (combinationCount(site) > 50000) continue;
    if (nTasks === 8) {
      if (tested8 >= 3) continue;
      tested8 += 1;
    } else {
      if (tested >= 30) continue;
      tested += 1;
    }
    const res = solveSite(site);
    if (res.status === 'INFEASIBLE') infeasible += 1;
    if (res.status === 'OVER_BUDGET') overBudget += 1;
    assertSameResult(site);
  }
  assert.ok(tested >= 30, `only ${tested} small cases tested`);
  assert.ok(tested8 >= 3, 'expected at least 3 eight-task cases');
  assert.ok(infeasible > 0, 'expected some infeasible random cases');
  assert.ok(overBudget > 0, 'expected some over-budget random cases');
});
