import test from 'node:test';
import assert from 'node:assert/strict';
import { materialize } from '../src/engine.js';

const render = (template, variables = {}) => materialize(template, variables).output;

test('pratt precedence: multiplication binds tighter than addition', () => {
  assert.equal(render('{{ 1 + 2 * 3 }}'), '7');
  assert.equal(render('{{ (1 + 2) * 3 }}'), '9');
});

test('arithmetic operators and unary minus', () => {
  assert.equal(render('{{ 10 % 3 }}'), '1');
  assert.equal(render('{{ 7 / 2 }}'), '3.5');
  assert.equal(render('{{ -4 + 5 }}'), '1');
  assert.equal(render('{{ 2 * -3 }}'), '-6');
});

test('filters bind looser than arithmetic and chain left to right', () => {
  assert.equal(render("{{ 'ab' + 'cd' | upper }}"), 'ABCD');
  assert.equal(render("{{ '  x ' | trim | upper }}"), 'X');
});

test('filters with arguments and array support', () => {
  assert.equal(render("{{ list | join(' + ') }}", { list: [1, 2, 3] }), '1 + 2 + 3');
  assert.equal(render('{{ list | length }}', { list: [1, 2, 3] }), '3');
  assert.equal(render("{{ 'abc' | length }}"), '3');
});

test('mixed text, interpolation and statements', () => {
  const template = 'A{{ 1 + 1 }}B{% scope s %}C{{ v }}{% end %}D';
  assert.equal(render(template, { s: { v: 'v!' } }), 'A2BCv!D');
});

test('unknown filter and stray end tag are rejected', () => {
  assert.throws(() => render('{{ 1 | nope }}'), (err) => err.code === 'UNKNOWN_FILTER');
  assert.throws(() => render('{% end %}'), (err) => err.code === 'UNEXPECTED_END');
});
