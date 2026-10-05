import assert from 'node:assert/strict';
import test from 'node:test';
import { moveDistance, validateLayout, type Problem } from '../src/model.js';

const base: Problem = {
  grid: 10,
  rects: [
    { id: 'A', minW: 1, maxW: 4, minH: 1, maxH: 4 },
    { id: 'B', minW: 2, maxW: 3, minH: 2, maxH: 3 },
  ],
  alignments: [{ kind: 'pair', a: 'A', edgeA: 'right', b: 'B', edgeB: 'left' }],
  oldLayout: {
    A: { x: 0, y: 0, w: 2, h: 2 },
    B: { x: 5, y: 5, w: 2, h: 2 },
  },
};

test('valid layout passes validation; touching edges do not overlap', () => {
  const layout = {
    A: { x: 0, y: 0, w: 2, h: 2 },
    B: { x: 2, y: 0, w: 2, h: 2 },
  };
  assert.deepEqual(validateLayout(base, layout), []);
});

test('overlap is detected', () => {
  const v = validateLayout(
    { ...base, alignments: [] },
    {
      A: { x: 0, y: 0, w: 3, h: 2 },
      B: { x: 2, y: 0, w: 2, h: 2 },
    },
  );
  assert.ok(v.some((s) => s.includes('overlap')));
});

test('size range violation is detected', () => {
  const v = validateLayout(base, {
    A: { x: 0, y: 0, w: 5, h: 2 }, // width 5 > maxW 4
    B: { x: 5, y: 0, w: 2, h: 2 },
  });
  assert.ok(v.some((s) => s.includes('size')));
});

test('grid escape is detected', () => {
  const v = validateLayout(
    { ...base, alignments: [] },
    {
      A: { x: 9, y: 0, w: 2, h: 2 }, // x + w = 11 > grid 10
      B: { x: 0, y: 5, w: 2, h: 2 },
    },
  );
  assert.ok(v.some((s) => s.includes('grid')));
});

test('pair and fixed alignment violations are detected', () => {
  const pair = validateLayout(base, {
    A: { x: 0, y: 0, w: 2, h: 2 },
    B: { x: 3, y: 0, w: 2, h: 2 }, // B.left=3 != A.right=2
  });
  assert.ok(pair.some((s) => s.includes('alignment')));

  const fixedProblem: Problem = {
    ...base,
    alignments: [{ kind: 'fixed', a: 'A', edgeA: 'left', value: 4 }],
  };
  const fixed = validateLayout(fixedProblem, {
    A: { x: 0, y: 0, w: 2, h: 2 },
    B: { x: 5, y: 5, w: 2, h: 2 },
  });
  assert.ok(fixed.some((s) => s.includes('alignment')));
});

test('moveDistance sums Manhattan distances of top-left corners', () => {
  const layout = {
    A: { x: 1, y: 2, w: 2, h: 2 }, // 1 + 2 = 3
    B: { x: 3, y: 5, w: 2, h: 2 }, // |3-5| + 0 = 2
  };
  assert.equal(moveDistance(base, layout), 5);
});
