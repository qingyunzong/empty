import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, LexError } from '../src/lexer.js';

test('recognizes lot numbers, dates, strings', () => {
  const tokens = tokenize('LOT-2025-0001 2025-01-15 "flour" 42');
  assert.equal(tokens[0].type, 'LOT');
  assert.equal(tokens[0].value, 'LOT-2025-0001');
  assert.equal(tokens[1].type, 'DATE');
  assert.equal(tokens[1].value, '2025-01-15');
  assert.equal(tokens[2].type, 'STRING');
  assert.equal(tokens[2].value, 'flour');
  assert.equal(tokens[3].type, 'NUMBER');
  assert.equal(tokens[3].value, 42);
});

test('distinguishes lot-like identifiers from plain identifiers', () => {
  const tokens = tokenize('LOT-2025-0001 LOT12 lot');
  assert.equal(tokens[0].type, 'LOT');
  assert.equal(tokens[1].type, 'IDENT');
  assert.equal(tokens[2].type, 'IDENT');
});

test('reports line and column on lexical errors', () => {
  assert.throws(() => tokenize('let a = nodes();\nlet b = @;'), (e) => {
    assert.ok(e instanceof LexError);
    assert.equal(e.line, 2);
    return true;
  });
});

test('unterminated string is an error with line number', () => {
  assert.throws(() => tokenize('x\n"abc'), (e) => e.line === 2);
});
