import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeConflicts, conflictsBrute } from '../src/scheduler.js';

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Acceptance 1: enumerate all task pairs to verify the conflict set.
test('sweep-line conflict set equals brute-force all-pairs enumeration', () => {
  for (const seed of [1, 7, 42, 2026]) {
    const rand = mulberry32(seed);
    const tasks = {};
    const resources = ['R1', 'R2', 'R3', 'R4'];
    for (let i = 0; i < 40; i++) {
      const start = Math.floor(rand() * 60);
      const len = 1 + Math.floor(rand() * 12);
      const rs = resources.filter(() => rand() < 0.4);
      tasks[`t${i}`] = {
        id: `t${i}`,
        resources: rs.length ? rs : ['R1'],
        start,
        end: start + len,
        due: start + len,
        budget: 5,
      };
    }
    const fast = computeConflicts(tasks);
    const slow = conflictsBrute(tasks);
    assert.deepEqual(fast, slow, `seed ${seed}`);
    // explicit pair count sanity: every reported pair really overlaps+shares
    for (const key of fast) {
      const [a, b] = key.split('|');
      const ta = tasks[a];
      const tb = tasks[b];
      assert.ok(ta.start < tb.end && tb.start < ta.end);
      assert.ok(ta.resources.some((r) => tb.resources.includes(r)));
    }
  }
});

test('empty and disjoint schedules have no conflicts', () => {
  assert.deepEqual(computeConflicts({}), []);
  const tasks = {
    a: { id: 'a', resources: ['R1'], start: 0, end: 5, due: 5, budget: 0 },
    b: { id: 'b', resources: ['R1'], start: 5, end: 9, due: 9, budget: 0 },
    c: { id: 'c', resources: ['R2'], start: 0, end: 9, due: 9, budget: 0 },
  };
  assert.deepEqual(computeConflicts(tasks), []);
});
