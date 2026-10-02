import test from 'node:test';
import assert from 'node:assert/strict';
import { lex } from '../src/lexer.js';

test('lexes #!correction directive blocks and statements', () => {
  const lines = lex('#!correction main\nmul amount price qty\nclamp score 0 100\n');
  assert.equal(lines[0].kind, 'directive');
  assert.equal(lines[0].name, 'correction');
  assert.deepEqual(lines[0].args, ['main']);
  assert.equal(lines[1].kind, 'statement');
  assert.deepEqual(
    lines[1].tokens.map((t) => [t.type, t.value]),
    [['IDENT', 'mul'], ['IDENT', 'amount'], ['IDENT', 'price'], ['IDENT', 'qty']],
  );
  assert.deepEqual(lines[2].tokens[2], { type: 'NUMBER', value: 0, line: 3 });
});

test('quoted strings are single tokens, commas inside do not split', () => {
  const lines = lex('set note "hello, world"\nfilter status == "active"');
  assert.deepEqual(lines[0].tokens[2], { type: 'STRING', value: 'hello, world', line: 1 });
  assert.deepEqual(lines[1].tokens[3], { type: 'STRING', value: 'active', line: 2 });
});

test('string escapes and single quotes', () => {
  const lines = lex('set a "he said \\"hi\\""\nset b \'x\'');
  assert.equal(lines[0].tokens[2].value, 'he said "hi"');
  assert.equal(lines[1].tokens[2].value, 'x');
});

test('plain CSV lines inside #!table blocks, quoted cells keep commas', () => {
  const src = '#!table rates\nUSD,1.0\n"EUR, fr",1.1\nCNY,0.14\n';
  const lines = lex(src);
  assert.equal(lines[1].kind, 'csv');
  assert.deepEqual(lines[1].cells, ['USD', 1.0]);
  assert.deepEqual(lines[2].cells, ['EUR, fr', 1.1]);
  assert.deepEqual(lines[3].cells, ['CNY', 0.14]);
});

test('skips blank lines and # comments, tracks line numbers', () => {
  const lines = lex('\n# a comment\nset x 1\n');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].line, 3);
});

test('rejects unknown directives and unterminated strings', () => {
  assert.throws(() => lex('#!bogus x'), /Unknown directive/);
  assert.throws(() => lex('set x "unterminated'), /Unterminated string/);
  assert.throws(() => lex('#!table t\n"open,1'), /Unterminated quoted CSV cell/);
});
