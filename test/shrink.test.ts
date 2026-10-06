import assert from 'node:assert/strict';
import test from 'node:test';
import { defineProblem, isValidAssignment, shrinkAssignment } from '../src/index.js';

test('shrink preserves constraints and moves toward the domain minimum', () => {
  const problem = defineProblem({
    vars: [
      { name: 'x', min: 0, max: 100 },
      { name: 'y', min: 0, max: 100 },
    ],
    constraints: [
      { vars: ['x', 'y'], check: ({ x, y }) => (x ?? 0) + (y ?? 0) >= 10 },
      { vars: ['x'], check: ({ x }) => (x ?? 0) % 2 === 0 },
    ],
  });
  const shrunk = shrinkAssignment(problem, { x: 80, y: 60 });
  assert.ok(isValidAssignment(problem, shrunk));
  assert.ok((shrunk.x ?? 0) <= 80 && (shrunk.y ?? 0) <= 60);
  // Locally minimal: no single variable can drop further without breaking a constraint.
  assert.deepEqual(shrunk, { x: 0, y: 10 });
});

test('shrink rejects an invalid starting assignment', () => {
  const problem = defineProblem({
    vars: [{ name: 'x', min: 0, max: 5 }],
    constraints: [{ vars: ['x'], check: ({ x }) => (x ?? 0) >= 2 }],
  });
  assert.throws(() => shrinkAssignment(problem, { x: 0 }));
});

test('shrink walks toward zero across negative domains', () => {
  const problem = defineProblem({
    vars: [{ name: 'x', min: -50, max: 50 }],
    constraints: [{ vars: ['x'], check: ({ x }) => Math.abs(x ?? 0) >= 4 }],
  });
  const shrunk = shrinkAssignment(problem, { x: -37 });
  assert.ok(isValidAssignment(problem, shrunk));
  assert.equal(shrunk.x, -4);
});
