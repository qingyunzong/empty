import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFile } from '../src/parser.js';
import { compileRuleset } from '../src/compiler.js';

const compile = (src) => compileRuleset(parseFile(src)[0]);
const wrap = (expr) => `version 1\nrule g level global { deny when ${expr} }`;

test('static types: cidr / money / count are distinct', () => {
  assert.throws(() => compile(wrap('amount > 5')), /E_TYPE/);        // count vs money
  assert.throws(() => compile(wrap('count > 5CNY')), /E_TYPE/);      // money vs count
  assert.throws(() => compile(wrap('amount > 5.5')), /E_TYPE/);      // float is not a count
  assert.throws(() => compile(wrap('ip in 100..200')), /E_TYPE/);    // range on cidr field
  assert.throws(() => compile(wrap('ip > 5')), /E_TYPE/);            // cmp on cidr field
  assert.throws(() => compile(wrap('merchant > 3')), /E_TYPE/);      // ordered cmp on string
  assert.throws(() => compile(wrap('count in 1CNY..2CNY')), /E_TYPE/);
  assert.throws(() => compile(wrap('nope > 1')), /E_TYPE/);          // unknown field
  assert.throws(() => compile(wrap('5')), /E_TYPE/);                 // not a boolean condition
});

test('well-typed programs compile', () => {
  compile(wrap('amount > 5CNY and count <= 3'));
  compile(wrap('ip in 10.0.0.0/8'));
  compile(wrap('merchant == "M1" or tag != promo'));
  compile(wrap('amount in 1CNY..2CNY and count in 1..9'));
  compile(wrap('merchant in /M\\d+/ and channel in [web, app]'));
});

test('invalid CIDRs raise E_CIDR', () => {
  assert.throws(() => compile(wrap('ip in 999.0.0.0/8')), /E_CIDR/);
  assert.throws(() => compile(wrap('ip in 10.0.0.1/8')), /E_CIDR/);   // host bits set
  assert.throws(() => compile(wrap('ip in 10.0.0.0/33')), /E_CIDR/);
  compile(wrap('ip in 0.0.0.0/0'));                                    // valid
});
