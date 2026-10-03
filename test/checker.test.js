import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.js';
import { check, CheckError } from '../src/checker.js';

const checkSource = (src) => check(parse(src));

test('accepts a valid program with let alias', () => {
  const { rules } = checkSource('let limit = 80C\nalert r level critical on devices(/^d-/) when temp > limit for 5m');
  assert.equal(rules.length, 1);
  assert.equal(rules[0].level, 'critical');
});

test('acceptance 4a: unit mismatch fails (temp vs amperes)', () => {
  assert.throws(
    () => checkSource('alert r level info on devices(d1) when temp > 80A'),
    (e) => e instanceof CheckError && /unit mismatch/.test(e.message) && e.line === 1,
  );
  assert.throws(
    () => checkSource('alert r level info on devices(d1) when current > 5C'),
    (e) => e instanceof CheckError && /unit mismatch/.test(e.message),
  );
});

test('acceptance 4b: undeclared field fails', () => {
  assert.throws(
    () => checkSource('alert r level info on devices(d1) when pressure > 3'),
    (e) => e instanceof CheckError && /undeclared field or alias 'pressure'/.test(e.message),
  );
});

test('acceptance 4c: empty device group fails', () => {
  assert.throws(
    () => checkSource('alert r level info on devices() when temp > 80C'),
    (e) => e instanceof CheckError && /empty device group/.test(e.message),
  );
});

test('unknown alert level fails', () => {
  assert.throws(
    () => checkSource('alert r level fatal on devices(d1) when temp > 80C'),
    (e) => e instanceof CheckError && /unknown alert level 'fatal'/.test(e.message),
  );
});

test('let aliases follow lexical scope: later definitions shadow, use-before-def fails', () => {
  assert.throws(
    () => checkSource('alert r level info on devices(d1) when temp > limit\nlet limit = 80C'),
    (e) => e instanceof CheckError && /undeclared/.test(e.message),
  );
  // shadowing: second let wins for the second rule only
  const { rules } = checkSource(
    'let limit = 80C\nalert a level info on devices(d1) when temp > limit\nlet limit = 90C\nalert b level info on devices(d1) when temp > limit',
  );
  assert.equal(rules.length, 2);
  const findConst = (expr) => (expr.kind === 'cmp' && expr.right.resolved ? expr.right.resolved.value : null);
  assert.equal(findConst(rules[0].expr), 80);
  assert.equal(findConst(rules[1].expr), 90);
});

test('non-boolean rule condition and non-constant let fail', () => {
  assert.throws(() => checkSource('alert r level info on devices(d1) when temp'), CheckError);
  assert.throws(() => checkSource('let x = temp\nalert r level info on devices(d1) when temp > 1'), CheckError);
});
