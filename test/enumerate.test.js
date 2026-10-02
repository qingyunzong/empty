import test from 'node:test';
import assert from 'node:assert/strict';
import { planSchedule, validateRounds } from '../src/scheduler.js';
import { minRounds } from '../src/enumerate.js';

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// Random instance with n <= 9 batches. Fluid batches live in institution F
// whose quota equals capacity (non-binding), so the exact enumerator can
// treat fluid amounts as fungible. Atomic groups get binding quotas.
function randomScenario(rand) {
  const capacity = 4 + Math.floor(rand() * 9);
  const nGroupInst = 1 + Math.floor(rand() * 2);
  const institutions = { F: { quota: capacity } };
  const groupQuotas = [];
  for (let i = 0; i < nGroupInst; i += 1) {
    const quota = 2 + Math.floor(rand() * (capacity - 1));
    institutions[`G${i}`] = { quota };
    groupQuotas.push(quota);
  }
  const batches = [];
  const nGroups = 1 + Math.floor(rand() * 4);
  for (let g = 0; g < nGroups && batches.length < 8; g += 1) {
    const instIdx = Math.floor(rand() * nGroupInst);
    const maxTotal = Math.min(capacity, groupQuotas[instIdx]);
    const total = 1 + Math.floor(rand() * maxTotal);
    const members = total > 1 && rand() < 0.5 && batches.length < 7 ? 2 : 1;
    const first = members === 2 ? 1 + Math.floor(rand() * (total - 1)) : total;
    const parts = members === 2 ? [first, total - first] : [total];
    parts.forEach((amount, m) => {
      batches.push({
        id: `g${g}m${m}`,
        institution: `G${instIdx}`,
        priority: Math.floor(rand() * 6),
        amount,
        group: `g${g}`,
      });
    });
  }
  const nFluid = 1 + Math.floor(rand() * Math.min(3, 9 - batches.length));
  for (let f = 0; f < nFluid; f += 1) {
    batches.push({
      id: `f${f}`,
      institution: 'F',
      priority: Math.floor(rand() * 6),
      amount: 1 + Math.floor(rand() * 10),
    });
  }
  assert.ok(batches.length <= 9);
  return { capacity, agingLimit: null, institutions, batches };
}

test('scheduler rounds match exhaustive round bin-packing (n <= 9)', () => {
  for (let seed = 1; seed <= 300; seed += 1) {
    const input = randomScenario(lcg(seed));
    const { scenario, rounds } = planSchedule(input);
    validateRounds(scenario, rounds);
    const min = minRounds(input);
    assert.ok(rounds.length >= min, `seed ${seed}: scheduler beat the lower bound`);
    assert.ok(
      rounds.length <= min + 1,
      `seed ${seed}: scheduler used ${rounds.length} rounds, enumerated minimum is ${min}`,
    );
  }
});

test('enumerator lower bound is exact on hand-built cases', () => {
  const input = {
    capacity: 10,
    institutions: { G: { quota: 10 }, F: { quota: 10 } },
    batches: [
      { id: 'g1', institution: 'G', amount: 6, atomic: true },
      { id: 'g2', institution: 'G', amount: 6, atomic: true },
      { id: 'f1', institution: 'F', amount: 8 },
    ],
  };
  assert.equal(minRounds(input), 2);
  const { rounds } = planSchedule(input);
  assert.equal(rounds.length, 2);
});
