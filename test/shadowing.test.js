import test from 'node:test';
import assert from 'node:assert/strict';
import { materialize } from '../src/engine.js';

test('three-level shadowing renders hand-computed text', () => {
  const template =
    '[{{ name }}]' +
    '{% scope a %}[{{ name }}]' +
    '{% scope b %}[{{ name }}]{% end %}' +
    '[{{ name }}]{% end %}' +
    '[{{ name }}]';
  const variables = { name: 'L0', a: { name: 'L1', b: { name: 'L2' } } };
  const { output, trace } = materialize(template, variables);
  assert.equal(output, '[L0][L1][L2][L1][L0]');
  assert.deepEqual(
    trace.map((entry) => `${entry.name}@${entry.level}`),
    ['name@0', 'a@0', 'name@1', 'b@1', 'name@2', 'name@1', 'name@0'],
  );
});

test('scope field shadows outer variable only inside the block', () => {
  const template = '{{ x }}{% scope s %}{{ x }}{% end %}{{ x }}';
  const variables = { x: 'outer', s: { x: 'inner' } };
  const { output } = materialize(template, variables);
  assert.equal(output, 'outerinnerouter');
});

test('scope target must be an object', () => {
  assert.throws(
    () => materialize('{% scope n %}x{% end %}', { n: 5 }),
    (err) => err.code === 'TYPE_ERROR',
  );
});
