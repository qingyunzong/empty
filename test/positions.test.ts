import { test } from 'node:test';
import { equal, deepEqual } from 'node:assert/strict';
import { render } from '../src/index.js';
import { expectTemplateError } from './helpers.js';

test('security errors point at the forbidden key', () => {
  const error = expectTemplateError(() => render('line one\n{{ user.__proto__ }}', { user: {} }), 'SECURITY_ERROR');
  deepEqual(error.position, { offset: 17, line: 2, column: 9 });
});

test('unclosed tag errors point at the opening braces', () => {
  const error = expectTemplateError(() => render('abc {{ user', {}), 'SYNTAX_ERROR');
  deepEqual(error.position, { offset: 4, line: 1, column: 5 });
});

test('unclosed section errors point at the section opener', () => {
  const error = expectTemplateError(() => render('a\nb\n{{#if ok}}x', { ok: true }), 'SYNTAX_ERROR');
  deepEqual(error.position, { offset: 4, line: 3, column: 1 });
});

test('unbound identifier errors point at the identifier', () => {
  const error = expectTemplateError(() => render('{{   missing }}', {}), 'UNBOUND_IDENTIFIER');
  deepEqual(error.position, { offset: 5, line: 1, column: 6 });
});

test('type errors inside loops point at the offending expression', () => {
  const template = '{{#each users as u}}\n  {{ u.name.first }}\n{{/each}}';
  const error = expectTemplateError(() => render(template, { users: [{ name: null }] }), 'TYPE_ERROR');
  equal(error.position.line, 2);
});
