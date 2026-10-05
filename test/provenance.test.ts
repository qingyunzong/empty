import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/index.js';
import { assertMapping, originString } from './helpers.js';

test('exact segments for a small template', () => {
  const template = 'Hi {{name}}!';
  const result = render(template, { name: 'Bo' });
  assert.equal(result.output, 'Hi Bo!');
  assert.deepEqual(result.segments, [
    { text: 'Hi ', source: { kind: 'template', start: 0, end: 3 } },
    { text: 'Bo', source: { kind: 'variable', path: 'name', start: 0, end: 2 } },
    { text: '!', source: { kind: 'template', start: 11, end: 12 } },
  ]);
});

test('per-character origin string', () => {
  const result = render('Hi {{name}}!', { name: 'Bo' });
  assert.equal(originString(result), 'TTTVVT');
});

test('loop iterations carry resolved element paths', () => {
  const template = '{{#each items}}{{this}} {{/each}}';
  const result = render(template, { items: ['a', 'bb'] });
  assert.equal(result.output, 'a bb ');
  const paths = result.segments
    .filter((s) => s.source.kind === 'variable')
    .map((s) => (s.source as { path: string }).path);
  assert.deepEqual(paths, ['items[0]', 'items[1]']);
  assertMapping(template, { items: ['a', 'bb'] }, result);
});

test('mapping invariants on conditionals and nested loops', () => {
  const template =
    'Dear {{user.name}},{{#if user.vip}} VIP{{/if}} items: {{#each items}}{{this.qty}}x {{this.name}}; {{/each}}!';
  const data = {
    user: { name: 'Ann', vip: true },
    items: [
      { qty: 2, name: 'Book' },
      { qty: 1, name: 'Pen' },
    ],
  };
  const result = render(template, data);
  assert.equal(result.output, 'Dear Ann, VIP items: 2x Book; 1x Pen; !');
  assertMapping(template, data, result);
});

test('mapping invariants when a variable value contains template syntax', () => {
  const template = 'Notice: {{note}} --end';
  const data = { note: '{{#if x}}not a tag{{/if}}' };
  const result = render(template, data);
  assert.equal(result.output, 'Notice: {{#if x}}not a tag{{/if}} --end');
  assertMapping(template, data, result);
});
