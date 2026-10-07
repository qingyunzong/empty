import { test } from 'node:test';
import { equal, deepEqual, ok } from 'node:assert/strict';
import { render, tryRender } from '../src/index.js';
import { expectTemplateError } from './helpers.js';

test('interpolates nested own fields', () => {
  equal(render('Hello {{ user.name }}, you are {{ user.age }}!', { user: { name: 'Ada', age: 36 } }), 'Hello Ada, you are 36!');
});

test('supports bracket access with number and string keys', () => {
  equal(render('{{ items[0] }}-{{ items[2] }}', { items: ['a', 'b', 'c'] }), 'a-c');
  equal(render("{{ row['id'] }}", { row: { id: 7 } }), '7');
});

test('renders null and undefined as empty text', () => {
  equal(render('[{{ a }}][{{ b }}]', { a: null, b: undefined }), '[][]');
});

test('each loops over arrays and supports else', () => {
  equal(render('{{#each items as x}}[{{ x }}]{{/each}}', { items: [1, 2, 3] }), '[1][2][3]');
  equal(render('{{#each items as x}}[{{ x }}]{{else}}empty{{/each}}', { items: [] }), 'empty');
});

test('each loop variables see nested fields and shadow outer scopes', () => {
  const data = { users: [{ name: 'a' }, { name: 'b' }], name: 'outer' };
  equal(render('{{#each users as user}}{{ user.name }};{{/each}}{{ name }}', data), 'a;b;outer');
});

test('if/else picks the right branch', () => {
  equal(render('{{#if flag}}yes{{else}}no{{/if}}', { flag: true }), 'yes');
  equal(render('{{#if flag}}yes{{else}}no{{/if}}', { flag: 0 }), 'no');
});

test('built-in filters transform values', () => {
  equal(render("{{ name | upper }}", { name: 'ada' }), 'ADA');
  equal(render("{{ tags | join(' + ') }}", { tags: ['a', 'b'] }), 'a + b');
  equal(render('{{ list | length }}', { list: [1, 2, 3] }), '3');
  equal(render("{{ missing_value | default('n/a') }}", { missing_value: null }), 'n/a');
  equal(render("{{ name | trim | upper }}", { name: '  ada  ' }), 'ADA');
});

test('custom filters can be supplied and take precedence', () => {
  const out = render('{{ n | double }}', { n: 21 }, { filters: { double: (v) => Number(v) * 2 } });
  equal(out, '42');
});

test('circular data structures render finite paths without hanging', () => {
  const node: Record<string, unknown> = { name: 'root' };
  node['self'] = node;
  equal(render('{{ node.self.self.self.name }}', { node }), 'root');
});

test('arrays containing themselves can be iterated safely', () => {
  const list: unknown[] = ['a'];
  list.push(list);
  equal(render('{{#each list as x}}{{#if x}}*{{/if}}{{/each}}', { list }), '**');
});

test('errors abort the render and never yield partial output', () => {
  const template = 'safe prefix {{#each items as x}}{{ x }}{{/each}} {{ user.__proto__ }} trailing';
  const result = tryRender(template, { items: [1, 2, 3], user: {} });
  deepEqual(result.ok, false);
  if (!result.ok) {
    equal(result.error.code, 'SECURITY_ERROR');
    equal('output' in result, false);
  }
});

test('throwing render produces no observable partial string', () => {
  let observed: string | undefined;
  try {
    observed = render('partial text {{ missing }}', {});
  } catch {
    // expected
  }
  equal(observed, undefined);
});

test('unclosed tags and sections are syntax errors', () => {
  expectTemplateError(() => render('abc {{ user', {}), 'SYNTAX_ERROR');
  expectTemplateError(() => render('{{#if a}}never closed', { a: true }), 'SYNTAX_ERROR');
  expectTemplateError(() => render('{{/if}}', {}), 'SYNTAX_ERROR');
  expectTemplateError(() => render('{{#each items as x}}{{/if}}', { items: [] }), 'SYNTAX_ERROR');
});

test('unbound identifiers are reported', () => {
  const error = expectTemplateError(() => render('{{ missing }}', {}), 'UNBOUND_IDENTIFIER');
  ok(error.message.includes('missing'));
});

test('unknown filters are reported', () => {
  expectTemplateError(() => render('{{ a | nosuchfilter }}', { a: 1 }), 'UNKNOWN_FILTER');
});
