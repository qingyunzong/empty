import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFile } from '../src/parser.js';
import { compileRuleset } from '../src/compiler.js';

const compile = (src) => compileRuleset(parseFile(src)[0]);
const BASE = 'version 1\nrule g level global { deny when amount > 10000CNY }';

test('acceptance 1: inner loosening without override fails with E_OVERRIDE', () => {
  const src = `${BASE}\nrule m level merchant match merchant M1 { deny when amount > 12000CNY }`;
  assert.throws(() => compile(src), /E_OVERRIDE/);
});

test('explicit override compiles and leaves an audit trace', () => {
  const src = `${BASE}\nrule m level merchant match merchant M1 { override deny when amount > 12000CNY }`;
  const rs = compile(src);
  assert.equal(rs.overrideLog.length, 1);
  const entry = rs.overrideLog[0];
  assert.equal(entry.rule, 'm');
  assert.equal(entry.outerRule, 'g');
  assert.equal(entry.field, 'amount');
  assert.equal(entry.outer, '> 10000CNY');
  assert.equal(entry.inner, '> 12000CNY');
});

test('tightening an outer threshold needs no override', () => {
  const src = `${BASE}\nrule c level channel match channel payx { deny when amount > 8000CNY }`;
  const rs = compile(src);
  assert.equal(rs.overrideLog.length, 0);
});

test('allow-loosening is guarded too (more events waved through)', () => {
  const src = `version 1
rule g level global { allow when amount < 1000CNY }
rule m level merchant match merchant M1 { allow when amount < 2000CNY }`;
  assert.throws(() => compile(src), /E_OVERRIDE/);
});

test('merchant level is checked against both channel and global', () => {
  const src = `version 1
rule g level global { deny when amount > 10000CNY }
rule c level channel match channel payx { deny when amount > 8000CNY }
rule m level merchant match merchant M1 { deny when amount > 9000CNY }`;
  assert.throws(() => compile(src), /E_OVERRIDE/); // loosens c (8000) even though it tightens g
});

test('count thresholds and upper-bound operators are checked', () => {
  const ok = `version 1
rule g level global { review when count > 10 }
rule c level channel match channel web { review when count > 5 }`;
  compile(ok);
  const bad = `version 1
rule g level global { deny when count < 2 }
rule c level channel match channel web { deny when count < 1 }`;
  assert.throws(() => compile(bad), /E_OVERRIDE/);
});
