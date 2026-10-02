import test from 'node:test';
import assert from 'node:assert/strict';
import { materialize } from '../src/materialize.js';

test('arithmetic precedence and parentheses', () => {
  assert.equal(materialize('{{ 1 + 2 * 3 }}', {}).output, '7');
  assert.equal(materialize('{{ (1 + 2) * 3 }}', {}).output, '9');
  assert.equal(materialize('{{ 10 % 4 - -2 }}', {}).output, '4');
});

test('filters apply after arithmetic and to fields', () => {
  assert.equal(materialize("{{ 'hi' | upper }}", {}).output, 'HI');
  assert.equal(materialize('{{ user.name | trim | upper }}', { user: { name: '  ada ' } }).output, 'ADA');
  assert.equal(materialize("{{ 1 + 2 | abs }}", {}).output, '3');
  assert.equal(materialize("{{ 'abc' | length }}", {}).output, '3');
});

test('string concatenation with +', () => {
  assert.equal(materialize("{{ 'a' + 'b' + x }}", { x: 'c' }).output, 'abc');
});
