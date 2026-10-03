'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, ParseError } = require('../src/parser');
const { buildLedger } = require('../src/build');

const KEY = 'test-key';

test('pratt parser: & binds tighter than |>, which binds tighter than requires', () => {
  const ledger = buildLedger(parse([
    'evidence E1',
    'evidence E2',
    'evidence E3',
    'rule R1',
    'claim C1 = E1 & E2 |> R1',
    'claim C2 = C1 requires E3',
  ].join('\n')), KEY);
  const c1 = ledger.symbols.get('C1');
  assert.equal(c1.canon, '((E1 & E2) |> R1)');
  const c2 = ledger.symbols.get('C2');
  assert.equal(c2.canon, '(C1 requires E3)');
});

test('pratt parser: requires is the loosest operator', () => {
  const ledger = buildLedger(parse([
    'evidence E1',
    'evidence E2',
    'rule R1',
    'claim C1 = E1 |> R1 requires E2',
  ].join('\n')), KEY);
  assert.equal(ledger.symbols.get('C1').canon, '((E1 |> R1) requires E2)');
});

test('parentheses override precedence', () => {
  const ledger = buildLedger(parse([
    'evidence E1',
    'evidence E2',
    'rule R1',
    'claim C1 = E1 |> R1',
    'claim C2 = E2 |> R1',
    'claim C3 = (C1 requires E2) & C2',
  ].join('\n')), KEY);
  assert.equal(ledger.symbols.get('C3').canon, '((C1 requires E2) & C2)');
});

test('conjunction is canonicalized with sorted operands', () => {
  const ledger = buildLedger(parse([
    'evidence E1',
    'evidence E2',
    'rule R1',
    'claim C1 = (E2 & E1) |> R1',
  ].join('\n')), KEY);
  assert.equal(ledger.symbols.get('C1').canon, '((E1 & E2) |> R1)');
});

test('unterminated block and stray tokens are parse errors', () => {
  assert.throws(() => parse('{ evidence E1'), ParseError);
  assert.throws(() => parse('claim C1 = '), ParseError);
  assert.throws(() => parse('evidence'), ParseError);
});
