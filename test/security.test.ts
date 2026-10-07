import { test } from 'node:test';
import { equal } from 'node:assert/strict';
import { render } from '../src/index.js';
import { expectTemplateError } from './helpers.js';

const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];

test('forbidden keys are rejected as member access', () => {
  for (const key of FORBIDDEN_KEYS) {
    const error = expectTemplateError(() => render(`{{ user.${key} }}`, { user: { name: 'a' } }), 'SECURITY_ERROR');
    equal(error.position.line, 1);
  }
});

test('forbidden keys are rejected as root identifiers', () => {
  for (const key of FORBIDDEN_KEYS) {
    expectTemplateError(() => render(`{{ ${key} }}`, {}), 'SECURITY_ERROR');
  }
});

test('forbidden keys are rejected even as own data properties', () => {
  const user: Record<string, unknown> = {};
  Object.defineProperty(user, 'constructor', { value: 'planted', enumerable: true });
  expectTemplateError(() => render('{{ user.constructor }}', { user }), 'SECURITY_ERROR');
});

test('forbidden keys are rejected via bracket access', () => {
  expectTemplateError(() => render("{{ user['__proto__'] }}", { user: {} }), 'SECURITY_ERROR');
  expectTemplateError(() => render("{{ user['constructor'] }}", { user: {} }), 'SECURITY_ERROR');
});

test('inherited prototype properties are not readable', () => {
  const proto = { secret: 'leaked' };
  const user = Object.create(proto) as Record<string, unknown>;
  user['name'] = 'ada';
  equal(render('{{ user.name }}', { user }), 'ada');
  expectTemplateError(() => render('{{ user.secret }}', { user }), 'SECURITY_ERROR');
});

test('class instance methods on the prototype are not readable', () => {
  class User {
    name = 'ada';
    greet(): string {
      return 'hi';
    }
  }
  const user = new User();
  equal(render('{{ user.name }}', { user }), 'ada');
  expectTemplateError(() => render('{{ user.greet }}', { user }), 'SECURITY_ERROR');
});

test('built-in prototype members like toString are not readable', () => {
  expectTemplateError(() => render('{{ user.toString }}', { user: {} }), 'SECURITY_ERROR');
  expectTemplateError(() => render('{{ user.hasOwnProperty }}', { user: {} }), 'SECURITY_ERROR');
});

test('function values cannot be interpolated or traversed', () => {
  expectTemplateError(() => render('{{ fn }}', { fn: () => 1 }), 'SECURITY_ERROR');
  expectTemplateError(() => render('{{ fn.call }}', { fn: () => 1 }), 'SECURITY_ERROR');
});

test('objects and arrays cannot be interpolated wholesale', () => {
  expectTemplateError(() => render('{{ user }}', { user: { a: 1 } }), 'TYPE_ERROR');
  expectTemplateError(() => render('{{ list }}', { list: [1] }), 'TYPE_ERROR');
});

test('each rejects non-array values instead of enumerating keys', () => {
  expectTemplateError(() => render('{{#each obj as x}}{{/each}}', { obj: { a: 1 } }), 'TYPE_ERROR');
});

test('deeply chained malicious access stops at the first forbidden hop', () => {
  const error = expectTemplateError(
    () => render('{{ a.__proto__.constructor.constructor }}', { a: {} }),
    'SECURITY_ERROR',
  );
  equal(error.position.line, 1);
});
