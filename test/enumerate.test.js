import assert from 'node:assert/strict';
import test from 'node:test';
import { TraceStore } from '../src/store.js';
import { solve } from '../src/solve.js';
import { validateInput } from '../src/model.js';
import { checkAssignment, enumerateAssignments } from '../src/bruteforce.js';
import { mulberry32, randomInstance } from './helpers.js';

// Acceptance 1: on small random instances the solver must agree with an
// exhaustive enumeration of every legal parent subset and quantity split.
test('solver agrees with exhaustive enumeration on small instances', () => {
  const rand = mulberry32(20261003);
  let feasibleCount = 0;
  let infeasibleCount = 0;
  for (let trial = 0; trial < 60; trial += 1) {
    const raw = randomInstance(rand);
    const input = validateInput(raw);
    const store = new TraceStore();
    store.applyTransaction(input);
    const result = solve(store, { budget: 1000000 });
    const solutions = [...enumerateAssignments(input, { limit: 50 })];

    if (solutions.length === 0) {
      infeasibleCount += 1;
      assert.equal(
        result.status,
        'infeasible',
        `trial ${trial}: enumerator found nothing but solver said ${result.status}`,
      );
      assert.ok(result.conflict.batches.length > 0, 'conflict must name batches');
      assert.ok(result.conflict.constraints.length > 0, 'conflict must name constraints');
    } else {
      feasibleCount += 1;
      assert.equal(
        result.status,
        'feasible',
        `trial ${trial}: enumerator found ${solutions.length} solutions but solver said ${result.status}`,
      );
      // The solver's assignment must itself be one of the legal assignments.
      assert.deepEqual(checkAssignment(input, result.assignment), []);
    }
  }
  assert.ok(feasibleCount > 0, 'expected at least one feasible random instance');
  assert.ok(infeasibleCount > 0, 'expected at least one infeasible random instance');
});

test('enumerator counts match hand-computed splits', () => {
  const input = validateInput({
    materials: [
      { id: 'M1', quantity: 10, expiry: '2026-12-01' },
      { id: 'M2', quantity: 10, expiry: '2026-12-01' },
    ],
    batches: [
      {
        id: 'P1',
        line: 'L1',
        start: '2026-01-01T00:00:00Z',
        end: '2026-01-01T02:00:00Z',
        output: 3,
        loss: 1,
        expiry: '2026-06-01',
        candidates: ['M1', 'M2'],
      },
    ],
  });
  // Splits of 4 into two parents: (0,4),(1,3),(2,2),(3,1),(4,0) -> 5.
  assert.equal([...enumerateAssignments(input)].length, 5);
});
