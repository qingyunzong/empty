import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, pctToBp } from '../src/lexer.js';
import { NetError } from '../src/errors.js';

test('lexer emits member, currency, obligation id and percent tokens', () => {
  const toks = tokenize('@M1 USD #O1 2.5% 2026-10-04 "str" name1');
  const kinds = toks.map((t) => t.t);
  assert.deepEqual(kinds, ['MEMBER', 'CCY', 'OBLID', 'PCT', 'DATE', 'STRING', 'IDENT', 'EOF']);
  assert.equal(toks[0].v, 'M1');
  assert.equal(toks[1].v, 'USD');
  assert.equal(toks[2].v, 'O1');
  assert.equal(toks[3].v, '2.5%');
});

test('percent literals convert to basis points with integer math', () => {
  assert.equal(pctToBp('2.5%'), 250n);
  assert.equal(pctToBp('100%'), 10000n);
  assert.equal(pctToBp('0.05%'), 5n);
  assert.equal(pctToBp('7%'), 700n);
});

test('over-precise percent literal is rejected (no floats allowed)', () => {
  assert.throws(() => tokenize('1.234%'), (e) => e instanceof NetError && e.code === 'E_PARSE');
});

test('comments and keywords', () => {
  const toks = tokenize('// hi\nconst day filter nettable expect cycle and or not min max abs net');
  const kinds = toks.map((t) => t.t);
  assert.deepEqual(kinds, ['CONST', 'DAY', 'FILTER', 'NETTABLE', 'EXPECT', 'CYCLE', 'AND', 'OR', 'NOT', 'MIN', 'MAX', 'ABS', 'NET', 'EOF']);
});
