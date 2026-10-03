import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { typeCheckContract } from '../src/typecheck.js';

const CONTRACT = `
contract "T" {
  defaults { rate = 25bps floor = 1.00 CNY }
  rounding HALF_EVEN
  residual to TAIL
  fee = {
    tier on [0.00 CNY, 100.00 CNY) fee = rate min floor
    tier on [100.00 CNY, ) fee = 10bps max 500.00 CNY
  }
}`;

test('parses tiered fee with min/max clauses', () => {
  const ast = parse(tokenize(CONTRACT));
  assert.equal(ast.name, 'T');
  assert.equal(ast.rounding, 'HALF_EVEN');
  assert.equal(ast.residual, 'TAIL');
  assert.equal(ast.fee.kind, 'tierList');
  assert.equal(ast.fee.tiers.length, 2);
  assert.equal(ast.fee.tiers[0].fee.kind, 'min');
  assert.equal(ast.fee.tiers[0].fee.expr.kind, 'ref');
  assert.equal(ast.fee.tiers[1].fee.kind, 'max');
  assert.equal(ast.fee.tiers[1].to, null);
});

test('inclusive upper bound with ]', () => {
  const src = `contract "T" { rounding DOWN residual to T fee = { tier on [0.00 CNY, 5.00 CNY] fee = 1bps } }`;
  const ast = parse(tokenize(src));
  assert.equal(ast.fee.tiers[0].toInclusive, true);
});

test('static types: bps + money is rejected', () => {
  const src = `contract "T" { rounding DOWN residual to T fee = 25bps + 1.00 CNY }`;
  assert.throws(() => typeCheckContract(parse(tokenize(src))), /E_TYPE: cannot add bps and money/);
});

test('static types: money + money and bps + bps are allowed', () => {
  const ok1 = `contract "T" { rounding DOWN residual to T fee = 1.00 CNY + 2.00 CNY }`;
  assert.equal(typeCheckContract(parse(tokenize(ok1))).feeType, 'money');
  const ok2 = `contract "T" { rounding DOWN residual to T fee = 25bps + 5bps }`;
  assert.equal(typeCheckContract(parse(tokenize(ok2))).feeType, 'bps');
});

test('static types: min bound must be money', () => {
  const src = `contract "T" { rounding DOWN residual to T fee = 25bps min 10bps }`;
  assert.throws(() => typeCheckContract(parse(tokenize(src))), /E_TYPE: min bound/);
});

test('static types: unknown parameter reference', () => {
  const src = `contract "T" { rounding DOWN residual to T fee = missing }`;
  assert.throws(() => typeCheckContract(parse(tokenize(src))), /E_TYPE: unknown parameter 'missing'/);
});

test('static types: tier bounds must be money', () => {
  const src = `contract "T" { rounding DOWN residual to T fee = { tier on [0.00 CNY, 5 units) fee = 1bps } }`;
  assert.throws(() => typeCheckContract(parse(tokenize(src))), /E_TYPE: tier upper bound/);
});

test('bare number without unit is a parse error', () => {
  const src = `contract "T" { rounding DOWN residual to T fee = 25 }`;
  assert.throws(() => parse(tokenize(src)), /E_PARSE: bare number/);
});

test('missing residual account is a parse error', () => {
  const src = `contract "T" { rounding DOWN fee = 25bps }`;
  assert.throws(() => parse(tokenize(src)), /E_PARSE:.*residual/);
});
