import test from 'node:test';
import assert from 'node:assert/strict';
import { render, RenderError } from '../src/index.js';

test('plain text passes through unchanged', () => {
  assert.equal(render('Hello, world!', {}).output, 'Hello, world!');
});

test('variable interpolation with dotted paths', () => {
  const result = render('Hello {{ user.name }}!', { user: { name: 'Ann' } });
  assert.equal(result.output, 'Hello Ann!');
});

test('numbers, booleans and null stringify', () => {
  const result = render('{{n}}|{{b}}|{{z}}', { n: 3, b: false, z: null });
  assert.equal(result.output, '3|false|');
});

test('substituted content is not interpreted recursively', () => {
  const data = { name: '{{#if x}}hacked{{/if}} and {{other}}' };
  const result = render('{{name}}', data);
  assert.equal(result.output, '{{#if x}}hacked{{/if}} and {{other}}');
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].source.kind, 'variable');
});

test('if/else picks the taken branch only', () => {
  const tpl = '{{#if user.vip}}VIP{{else}}regular{{/if}}';
  assert.equal(render(tpl, { user: { vip: true } }).output, 'VIP');
  assert.equal(render(tpl, { user: { vip: false } }).output, 'regular');
});

test('falsy values: 0, empty string, empty array, null', () => {
  const tpl = '{{#if v}}yes{{else}}no{{/if}}';
  assert.equal(render(tpl, { v: 0 }).output, 'no');
  assert.equal(render(tpl, { v: '' }).output, 'no');
  assert.equal(render(tpl, { v: [] }).output, 'no');
  assert.equal(render(tpl, { v: null }).output, 'no');
  assert.equal(render(tpl, { v: [1] }).output, 'yes');
});

test('each iterates with this and @index', () => {
  const tpl = '{{#each items}}[{{@index}}]{{this.name}};{{/each}}';
  const data = { items: [{ name: 'a' }, { name: 'b' }] };
  assert.equal(render(tpl, data).output, '[0]a;[1]b;');
});

test('nested each loops', () => {
  const tpl = '{{#each rows}}{{#each this.cells}}{{this}} {{/each}}|{{/each}}';
  const data = { rows: [{ cells: ['a', 'b'] }, { cells: ['c'] }] };
  assert.equal(render(tpl, data).output, 'a b |c |');
});

test('bare names fall back to outer scopes', () => {
  const tpl = '{{#each items}}{{this}}{{suffix}}{{/each}}';
  assert.equal(render(tpl, { items: ['a', 'b'], suffix: '!' }).output, 'a!b!');
});

test('comments are removed', () => {
  assert.equal(render('a{{! note to self }}b', {}).output, 'ab');
});

test('each over null renders nothing, non-array throws', () => {
  assert.equal(render('{{#each xs}}x{{/each}}', { xs: null }).output, '');
  assert.throws(() => render('{{#each n}}x{{/each}}', { n: 5 }), RenderError);
});

test('interpolating objects or arrays throws', () => {
  assert.throws(() => render('{{o}}', { o: {} }), RenderError);
  assert.throws(() => render('{{a}}', { a: [1] }), RenderError);
});

test('undefined variable throws with the tag range', () => {
  assert.throws(
    () => render('Hi {{user.missing}}!', { user: {} }),
    (err: unknown) => {
      assert.ok(err instanceof RenderError);
      assert.equal((err as RenderError).path, 'user.missing');
      return true;
    },
  );
});
