import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, materialize } from '../src/materialize.js';
import { render } from '../src/vm.js';

// Small template with nested scopes; every variable load records which
// frame of the scope chain it resolved to (0 = root variables frame).
// The expected table below is enumerated by hand from the template.
const TEMPLATE =
  '{% scope a = 1 %}{{ a }}{{ b }}{% scope b = 2 %}{{ a }}{{ b }}{% end %}{% end %}';
const VARIABLES = { a: 0, b: 9 };

// frames: 0 = { a: 0, b: 9 } (root), 1 = { a: 1 }, 2 = { b: 2 }
const EXPECTED_TABLE = [
  { name: 'a', resolvedAt: 1 }, // inner a shadows root
  { name: 'b', resolvedAt: 0 }, // falls through frame 1 to root
  { name: 'a', resolvedAt: 1 }, // frame 2 misses, frame 1 hits
  { name: 'b', resolvedAt: 2 }, // innermost b shadows root
];

test('variable resolution paths match the hand-enumerated table', () => {
  const trace = [];
  const { output } = render(compile(TEMPLATE), VARIABLES, { trace });
  assert.deepEqual(trace, EXPECTED_TABLE);
  assert.equal(output, '1912'); // a=1, b=9, a=1, b=2
});

test('materialize also exposes the trace via opts', () => {
  const trace = [];
  materialize(TEMPLATE, VARIABLES, { trace });
  assert.deepEqual(trace, EXPECTED_TABLE);
});
