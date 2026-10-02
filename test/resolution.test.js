import test from 'node:test';
import assert from 'node:assert/strict';
import { materialize } from '../src/engine.js';

const cases = [
  {
    name: 'root variable resolves at level 0',
    template: '{{ x }}',
    variables: { x: 1 },
    output: '1',
    path: [{ name: 'x', level: 0 }],
  },
  {
    name: 'scope field shadows the root binding',
    template: '{% scope s %}{{ x }}{% end %}',
    variables: { x: 'root', s: { x: 'inner' } },
    output: 'inner',
    path: [
      { name: 's', level: 0 },
      { name: 'x', level: 1 },
    ],
  },
  {
    name: 'unbound name falls through to the root scope',
    template: '{% scope s %}{{ y }}{% end %}',
    variables: { y: 'root', s: {} },
    output: 'root',
    path: [
      { name: 's', level: 0 },
      { name: 'y', level: 0 },
    ],
  },
  {
    name: 'inner scope shadows, middle scope still sees its own binding',
    template: '{% scope a %}{% scope b %}{{ v }}{% end %}{{ v }}{% end %}',
    variables: { v: 'root', a: { v: 'mid', b: { v: 'leaf' } } },
    output: 'leafmid',
    path: [
      { name: 'a', level: 0 },
      { name: 'b', level: 1 },
      { name: 'v', level: 2 },
      { name: 'v', level: 1 },
    ],
  },
  {
    name: 'field chain does not emit variable loads',
    template: '{{ a.b.c }}',
    variables: { a: { b: { c: 42 } } },
    output: '42',
    path: [{ name: 'a', level: 0 }],
  },
  {
    name: 'undefined variable aborts with UNDEFINED_VARIABLE',
    template: '{{ z }}',
    variables: {},
    error: 'UNDEFINED_VARIABLE',
  },
  {
    name: 'missing deep field aborts with MISSING_FIELD',
    template: '{{ a.b.c }}',
    variables: { a: {} },
    error: 'MISSING_FIELD',
  },
  {
    name: 'field access on a scalar aborts with MISSING_FIELD',
    template: '{{ n.b }}',
    variables: { n: 7 },
    error: 'MISSING_FIELD',
  },
];

for (const entry of cases) {
  test(`resolution table: ${entry.name}`, () => {
    if (entry.error) {
      assert.throws(
        () => materialize(entry.template, entry.variables),
        (err) => err.code === entry.error,
      );
      return;
    }
    const { output, trace } = materialize(entry.template, entry.variables);
    assert.equal(output, entry.output);
    assert.deepEqual(trace, entry.path);
  });
}
