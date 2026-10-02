'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../src/cli.js');

test('CLI driver applies ops transactionally and reports exact fractions', () => {
  const input = {
    devices: [
      { id: 'A', rects: [[0, 0, 2, 2]] },
      { id: 'B', rects: [[2, 0, 4, 2]] },
    ],
    defects: [{ id: 'd', rect: [1, 0, 3, 2] }],
    ops: [
      { op: 'move', defect: 'd', dx: '1/2', dy: 0 },
      { op: 'scale', defect: 'd', factor: 0 },
      { op: 'undo' },
    ],
  };
  const out = run(input);
  assert.equal(out.ops[0].ok, true);
  assert.equal(out.ops[1].ok, false);
  assert.equal(out.ops[1].rolledBack, true);
  assert.equal(out.ops[2].ok, true);
  const [d] = out.report.defects;
  assert.deepEqual(d.rect, ['1', '0', '3', '2']); // move was undone
  assert.deepEqual(d.responsible, ['A', 'B']);
});
