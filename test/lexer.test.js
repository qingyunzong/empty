'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { lex, ParseError } = require('../src/lexer');
const { compile, OPCODES, CompileError } = require('../src/compiler');

test('lexer separates structured events from note: free text', () => {
  const tokens = lex([
    'note: observers came online at dawn',
    'n1 1 commit temp = 21.5',
    '',
    '# a comment line',
    'n2 4 mask temp',
    'note: anything goes here, even n9 9 commit x = y',
  ].join('\n'));
  assert.equal(tokens.length, 4);
  assert.equal(tokens[0].kind, 'note');
  assert.equal(tokens[0].text, 'observers came online at dawn');
  assert.deepEqual(
    { kind: tokens[1].kind, node: tokens[1].node, clock: tokens[1].clock, op: tokens[1].op, key: tokens[1].key, value: tokens[1].value },
    { kind: 'event', node: 'n1', clock: 1, op: 'commit', key: 'temp', value: '21.5' },
  );
  assert.equal(tokens[2].op, 'mask');
  assert.equal(tokens[3].kind, 'note');
});

test('missing clock is a parse error', () => {
  assert.throws(() => lex('n1 commit temp = 21.5'), (err) => {
    assert.ok(err instanceof ParseError);
    assert.match(err.message, /logical clock/);
    return true;
  });
});

test('non-numeric clock is a parse error', () => {
  assert.throws(() => lex('n1 abc commit temp = 21.5'), ParseError);
});

test('commit without "= value" is a parse error', () => {
  assert.throws(() => lex('n1 3 commit temp'), /commit requires "= <value>"/);
});

test('compiler emits commit/mask/rollback/conflict-check bytecode', () => {
  const program = compile(lex([
    'n1 1 commit a = 1',
    'n2 1 commit a = 2',
    'n1 2 mask b',
    'n1 3 rollback a',
  ].join('\n')));
  const ops = program.code.map((i) => i.op);
  assert.deepEqual(ops, [OPCODES.COMMIT, OPCODES.COMMIT, OPCODES.MASK, OPCODES.ROLLBACK, OPCODES.CONFLICT_CHECK]);
});

test('duplicate (node, clock) event is rejected', () => {
  assert.throws(
    () => compile(lex('n1 1 commit a = 1\nn1 1 commit b = 2')),
    (err) => {
      assert.ok(err instanceof CompileError);
      assert.match(err.message, /duplicate event n1@1/);
      return true;
    },
  );
});

test('unknown causal dependency is rejected', () => {
  assert.throws(
    () => compile(lex('n1 1 commit a = 1 after n9@9')),
    /unknown causal dependency n9@9/,
  );
});
