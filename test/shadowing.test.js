import test from 'node:test';
import assert from 'node:assert/strict';
import { materialize } from '../src/materialize.js';

test('three-level shadowing renders hand-computed text', () => {
  const template =
    "{{ x }}|{% scope x = 'mid' %}{{ x }}|{% scope x = 'inner' %}{{ x }}{% end %}|{{ x }}{% end %}|{{ x }}";
  const { output } = materialize(template, { x: 'outer' });
  assert.equal(output, 'outer|mid|inner|mid|outer');
});

test('scope without initializer rebinds the outer value', () => {
  const template = "{% scope x %}{{ x }}{% scope x = 's' %}{{ x }}{% end %}{{ x }}{% end %}";
  const { output } = materialize(template, { x: 'o' });
  assert.equal(output, 'oso');
});

test('shadowing with arithmetic and nested fields', () => {
  const template = '{% scope u = user.profile %}{{ u.name }}:{{ u.age + 1 }}{% end %}';
  const { output } = materialize(template, { user: { profile: { name: 'ada', age: 36 } } });
  assert.equal(output, 'ada:37');
});
