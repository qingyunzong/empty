import test from 'node:test';
import assert from 'node:assert/strict';
import { Interpreter } from '../src/interp.js';
import { Model, schedule } from '../src/model.js';
import { feasibleReference, verifyPlacement, mulberry32 } from '../testlib/reference.js';

function randomCase(rand, idx) {
  const lines = ['L1', 'L2'];
  const parts = ['line L1, L2;'];
  const shiftHours = rand() < 0.25 ? 4 : 8;
  parts.push(`calendar main { shift mon..fri 08:00-${8 + shiftHours}:00; }`);
  const nMaint = Math.floor(rand() * 3);
  for (let k = 0; k < nMaint; k++) {
    const line = lines[Math.floor(rand() * 2)];
    const day = 5 + Math.floor(rand() * 5);
    const hour = 8 + Math.floor(rand() * 6);
    const dur = 1 + Math.floor(rand() * 2);
    parts.push(`maintenance ${line} @2026-01-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00 for ${dur}h;`);
  }
  const nJobs = 4 + Math.floor(rand() * 4); // 4..7 jobs
  for (let j = 0; j < nJobs; j++) {
    const line = lines[Math.floor(rand() * 2)];
    const dur = 30 * (1 + Math.floor(rand() * 6)); // 30m..3h
    const prio = 1 + Math.floor(rand() * 3);
    let after = '';
    if (j > 0 && rand() < 0.25) {
      const dep = Math.floor(rand() * j);
      after = ` after: J${dep};`;
    }
    parts.push(`job J${j} { line: ${line}; duration: ${dur}m; priority: ${prio};${after} }`);
  }
  for (const line of lines) {
    const k = 1 + Math.floor(rand() * 2);
    parts.push(`constraint overlap(${line}) <= ${k};`);
    if (rand() < 0.5) {
      const cap = [2, 6, 20, 60][Math.floor(rand() * 4)];
      parts.push(`constraint total(${line}) <= ${cap}h;`);
    }
  }
  return { src: parts.join('\n'), nJobs, idx };
}

test('scheduler agrees with exhaustive enumeration for <= 7 jobs (acceptance 4)', () => {
  const rand = mulberry32(20261003);
  const N = 40;
  let feasibleCount = 0;
  for (let i = 0; i < N; i++) {
    const { src, nJobs } = randomCase(rand, i);
    assert.ok(nJobs <= 7);
    const interp = new Interpreter(new Model());
    interp.runSource(src);
    const model = interp.model;
    const placed = schedule(model);
    const refFeasible = feasibleReference(model);
    assert.equal(
      placed !== null,
      refFeasible,
      `case ${i}: engine=${placed !== null} reference=${refFeasible}\n${src}`,
    );
    if (placed) {
      feasibleCount++;
      const problem = verifyPlacement(model, placed);
      assert.equal(problem, null, `case ${i}: invalid placement: ${problem}\n${src}`);
    }
  }
  // The random suite must exercise both outcomes.
  assert.ok(feasibleCount > 0, 'expected some feasible cases');
  assert.ok(feasibleCount < N, 'expected some infeasible cases');
});

test('handwritten edge cases match the reference', () => {
  const cases = [
    // Job longer than any shift window.
    `line L1;
     calendar c { shift mon 08:00-09:00; }
     job J1 { line: L1; duration: 2h; }
     constraint overlap(L1) <= 1;`,
    // Total capacity exceeded.
    `line L1;
     calendar c { shift mon..fri 08:00-16:00; }
     job J1 { line: L1; duration: 2h; }
     job J2 { line: L1; duration: 2h; }
     constraint total(L1) <= 3h;`,
    // Concurrency 2 allows parallel pair.
    `line L1;
     calendar c { shift mon..fri 08:00-16:00; }
     job J1 { line: L1; duration: 2h; }
     job J2 { line: L1; duration: 2h; }
     constraint overlap(L1) <= 2;`,
    // Dependency chain across the weekend.
    `line L1;
     calendar c { shift mon..fri 08:00-09:00; }
     job J1 { line: L1; duration: 1h; }
     job J2 { line: L1; duration: 1h; after: J1; }
     job J3 { line: L1; duration: 1h; after: J2; }
     constraint overlap(L1) <= 1;`,
  ];
  for (const src of cases) {
    const interp = new Interpreter(new Model());
    interp.runSource(src);
    const placed = schedule(interp.model);
    assert.equal(placed !== null, feasibleReference(interp.model), src);
  }
});
