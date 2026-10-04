import test from "node:test";
import assert from "node:assert/strict";
import {
  allocate,
  attributeSweep,
  exhaustiveOptimum,
  verifyAllocation,
} from "../src/index";
import { HORIZON, normalizeShifts } from "../src/normalize";
import { Shift } from "../src/types";
import { greedyAllocate, mulberry32, randomShifts } from "./helpers";

test("joint allocation covers more than point-wise greedy", () => {
  const shifts: Shift[] = [
    { id: 1, priority: 9, work: [{ start: 0, end: 2 }], maxWork: 1 },
    { id: 2, priority: 1, work: [{ start: 0, end: 1 }] },
  ];
  const result = allocate(shifts);
  assert.equal(result.coverage, 2);
  assert.equal(result.benefit, 10);
  assert.deepEqual(result.segments, [
    { shiftId: 2, start: 0, end: 1 },
    { shiftId: 1, start: 1, end: 2 },
  ]);
  const greedy = greedyAllocate(shifts);
  assert.equal(greedy.coverage, 1);
  assert.ok(greedy.coverage < result.coverage);
  assert.deepEqual(verifyAllocation(shifts, result), []);
});

test("maxWork caps attributed seconds", () => {
  const shifts: Shift[] = [
    { id: 1, priority: 5, work: [{ start: 0, end: 10 }], maxWork: 3 },
  ];
  const result = allocate(shifts);
  assert.equal(result.coverage, 3);
  assert.equal(result.totals.get(1), 3);
  assert.deepEqual(verifyAllocation(shifts, result), []);
});

test("minRest forces unassigned rest inside work span", () => {
  const shifts: Shift[] = [
    { id: 1, priority: 5, work: [{ start: 0, end: 6 }], maxWork: 10, minRest: 2 },
  ];
  const result = allocate(shifts);
  assert.equal(result.coverage, 4);
  const cert = result.certificates.find((c) => c.shiftId === 1)!;
  assert.equal(cert.restSeconds, 2);
  assert.equal(cert.minRest, 2);
  assert.ok(cert.ok);
  assert.deepEqual(verifyAllocation(shifts, result), []);
});

test("explicit rest counts toward minRest certificate", () => {
  const shifts: Shift[] = [
    {
      id: 1,
      priority: 5,
      work: [{ start: 0, end: 6 }],
      rest: [{ start: 2, end: 4 }],
      minRest: 3,
    },
  ];
  const result = allocate(shifts);
  assert.equal(result.coverage, 3);
  const cert = result.certificates.find((c) => c.shiftId === 1)!;
  assert.deepEqual(cert.explicitRest, [{ start: 2, end: 4 }]);
  assert.equal(cert.restSeconds, 3);
  assert.ok(cert.ok);
  assert.deepEqual(verifyAllocation(shifts, result), []);
});

test("among maximal coverage, priority benefit is maximized", () => {
  const shifts: Shift[] = [
    { id: 1, priority: 5, work: [{ start: 0, end: 2 }], maxWork: 2 },
    { id: 2, priority: 9, work: [{ start: 0, end: 1 }], maxWork: 1 },
  ];
  const result = allocate(shifts);
  assert.equal(result.coverage, 2);
  assert.equal(result.benefit, 14);
  assert.deepEqual(verifyAllocation(shifts, result), []);
});

test("unconstrained allocation matches basic attribution coverage", () => {
  const rng = mulberry32(777);
  for (let iter = 0; iter < 200; iter++) {
    const shifts = randomShifts(rng, { maxShifts: 12, withCaps: false });
    const result = allocate(shifts);
    const basic = attributeSweep(shifts);
    assert.equal(result.coverage, basic.totalSeconds);
    const norm = normalizeShifts(shifts);
    let expectedBenefit = 0;
    for (let t = 0; t < HORIZON; t++) {
      let best = 0;
      for (const s of norm) {
        if (s.workable[t]) best = Math.max(best, s.priority);
      }
      expectedBenefit += best;
    }
    assert.equal(result.benefit, expectedBenefit);
    assert.deepEqual(verifyAllocation(shifts, result), []);
  }
});

test("allocation matches exhaustive search (fuzz)", () => {
  const rng = mulberry32(31337);
  let checked = 0;
  let skipped = 0;
  for (let iter = 0; iter < 300; iter++) {
    const shifts = randomShifts(rng, { maxShifts: 8, withCaps: true });
    const exhaustive = exhaustiveOptimum(shifts);
    if (exhaustive === null) {
      skipped++;
      continue;
    }
    checked++;
    const result = allocate(shifts);
    assert.equal(result.coverage, exhaustive.coverage, `coverage at iter ${iter}`);
    assert.equal(result.benefit, exhaustive.benefit, `benefit at iter ${iter}`);
    assert.deepEqual(verifyAllocation(shifts, result), []);
    for (const cert of result.certificates) assert.ok(cert.ok);
  }
  assert.ok(checked >= 250, `too many exhaustive skips: ${skipped}`);
});

test("allocation matches exhaustive search at the 12-shift limit", () => {
  const rng = mulberry32(999);
  let checked = 0;
  for (let iter = 0; iter < 25; iter++) {
    const shifts = randomShifts(rng, { maxShifts: 12, withCaps: true });
    const exhaustive = exhaustiveOptimum(shifts);
    if (exhaustive === null) continue;
    checked++;
    const result = allocate(shifts);
    assert.equal(result.coverage, exhaustive.coverage, `coverage at iter ${iter}`);
    assert.equal(result.benefit, exhaustive.benefit, `benefit at iter ${iter}`);
    assert.deepEqual(verifyAllocation(shifts, result), []);
  }
  assert.ok(checked >= 20, `too few 12-shift instances checked: ${checked}`);
});

test("exhaustive search confirms the greedy-gap instance", () => {
  const shifts: Shift[] = [
    { id: 1, priority: 9, work: [{ start: 0, end: 2 }], maxWork: 1 },
    { id: 2, priority: 1, work: [{ start: 0, end: 1 }] },
  ];
  const exhaustive = exhaustiveOptimum(shifts)!;
  assert.equal(exhaustive.coverage, 2);
  assert.equal(exhaustive.benefit, 10);
});
