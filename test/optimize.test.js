import test from 'node:test';
import assert from 'node:assert/strict';
import { optimize } from '../src/optimize.js';
import { validatePlan } from '../src/plan.js';

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genInstance(rand, n, machineCount) {
  const machines = Array.from({ length: machineCount }, (_, i) => 'M' + (i + 1));
  const jobCount = Math.max(1, Math.floor(n / 3));
  const jobs = Array.from({ length: jobCount }, (_, j) => ({
    id: 'j' + j,
    due: 4 + Math.floor(rand() * 10),
    weight: 1 + Math.floor(rand() * 3),
  }));
  const ops = [];
  for (let i = 0; i < n; i++) {
    const caps = machines.filter(() => rand() < 0.7);
    if (caps.length === 0) caps.push(machines[0]);
    const preds = [];
    for (let j = 0; j < i; j++) if (rand() < 0.4) preds.push('o' + j);
    ops.push({
      id: 'o' + i,
      job: 'j' + Math.floor(rand() * jobCount),
      machine: caps[0],
      start: 0,
      dur: 1 + Math.floor(rand() * 4),
      preds,
      machines: caps,
    });
  }
  return { jobs, ops };
}

// Independent brute force: enumerate every machine assignment and every
// permutation of operations; keep permutations that respect precedence;
// compute earliest-start schedule and weighted tardiness from scratch.
function bruteForce(plan) {
  const ops = plan.ops;
  const n = ops.length;
  const pos = new Map(ops.map((o, i) => [o.id, i]));
  const domains = ops.map((o) => (o.machines && o.machines.length ? o.machines : [o.machine]));
  let best = Infinity;
  const perm = Array.from({ length: n }, (_, i) => i);
  const assign = new Array(n).fill(0);

  function tardiness() {
    const endOf = new Array(n).fill(0);
    const freeAt = {};
    for (const i of perm) {
      const m = domains[i][assign[i]];
      let s = freeAt[m] || 0;
      for (const p of ops[i].preds || []) s = Math.max(s, endOf[pos.get(p)]);
      endOf[i] = s + ops[i].dur;
      freeAt[m] = endOf[i];
    }
    const jobEnd = {};
    for (let i = 0; i < n; i++) jobEnd[ops[i].job] = Math.max(jobEnd[ops[i].job] || 0, endOf[i]);
    let total = 0;
    for (const j of plan.jobs) {
      const e = jobEnd[j.id] || 0;
      if (e > j.due) total += (j.weight ?? 1) * (e - j.due);
    }
    return total;
  }

  function respectsPrecedence() {
    const seen = new Set();
    for (const i of perm) {
      for (const p of ops[i].preds || []) if (!seen.has(pos.get(p))) return false;
      seen.add(i);
    }
    return true;
  }

  function* permutations(k) {
    if (k === 1) { yield; return; }
    for (let i = 0; i < k; i++) {
      yield* permutations(k - 1);
      const j = k % 2 === 0 ? i : 0;
      [perm[j], perm[k - 1]] = [perm[k - 1], perm[j]];
    }
  }

  function enumAssign(i) {
    if (i === n) {
      for (const _ of permutations(n)) {
        if (respectsPrecedence()) best = Math.min(best, tardiness());
      }
      return;
    }
    for (let a = 0; a < domains[i].length; a++) { assign[i] = a; enumAssign(i + 1); }
  }
  enumAssign(0);
  return best;
}

test('optimize matches independent brute-force enumeration for n<=8', () => {
  const rand = mulberry32(20261003);
  const cases = [];
  for (const n of [4, 5, 6, 7]) {
    cases.push(genInstance(rand, n, 2));
    cases.push(genInstance(rand, n, 2));
  }
  cases.push(genInstance(rand, 8, 1));
  cases.push(genInstance(rand, 8, 1));
  for (const [k, plan] of cases.entries()) {
    const expected = bruteForce(plan);
    const got = optimize(plan);
    assert.equal(got.cost, expected, `case ${k}: optimal cost matches enumeration`);
    const scheduled = { jobs: plan.jobs, ops: got.schedule };
    assert.deepEqual(validatePlan(scheduled, {}), [], `case ${k}: optimal schedule is feasible`);
  }
});
