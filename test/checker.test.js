import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lex } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { check } from '../src/checker.js';

const checkSrc = (src) => check(parse(lex(src)));
const errorsOf = (src) => {
  try {
    checkSrc(src);
    return [];
  } catch (errs) {
    assert.ok(Array.isArray(errs), 'checker must throw an array of diagnostics');
    return errs;
  }
};

const PRELUDE = 'field temp: C; field current: A; group sensors = /^sensor-/;';

test('accepts a well-typed program', () => {
  const meta = checkSrc(`${PRELUDE}
    let limit = 80C;
    rule r on sensors { alert critical when temp > limit for 5m; }`);
  assert.equal(meta.fields.get('temp'), 'C');
  assert.equal(meta.groups.get('sensors'), '^sensor-');
});

test('unit mismatch fails with rule line/col', () => {
  const errs = errorsOf(`${PRELUDE}\nrule r on all { alert info when temp > 80A; }`);
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /unit mismatch/);
  assert.equal(errs[0].line, 2);
  assert.ok(errs[0].col > 0);
});

test('undeclared field fails', () => {
  const errs = errorsOf(`${PRELUDE} rule r on all { alert info when voltage > 5; }`);
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /undeclared field or alias "voltage"/);
});

test('unknown alert level fails', () => {
  const errs = errorsOf(`${PRELUDE} rule r on all { alert fatal when temp > 80C; }`);
  assert.match(errs[0].message, /unknown alert level "fatal"/);
});

test('unknown unit in field declaration fails', () => {
  const errs = errorsOf('field temp: K;');
  assert.match(errs[0].message, /unknown unit "K"/);
});

test('let aliases follow lexical scope: rule-local shadows global', () => {
  // Global x is current (A); rule-local x shadows it with temperature (C).
  const errs = errorsOf(`${PRELUDE}
    let x = 10A;
    rule r on all { let x = 90C; alert info when temp > x; }`);
  assert.deepEqual(errs, []);
});

test('shadowed alias still type-checks units against the inner binding', () => {
  const errs = errorsOf(`${PRELUDE}
    let x = 10A;
    rule r on all { let x = 90C; alert info when current > x; }`);
  assert.match(errs[0].message, /unit mismatch/);
});

test('forward references and use outside scope fail', () => {
  assert.match(errorsOf(`${PRELUDE} let a = b; let b = 1;`)[0].message, /"b"/);
  assert.match(
    errorsOf(`${PRELUDE} rule r on all { let y = 1; alert info when temp > 1C; } rule s on all { alert info when temp > y; }`)[0].message,
    /"y"/,
  );
});

test('collects multiple diagnostics in one pass', () => {
  const errs = errorsOf(`${PRELUDE}
    rule r on all { alert fatal when temp > 80A; }
    rule s on all { alert info when voltage > 1; }`);
  assert.ok(errs.length >= 3); // level + unit + undeclared
});
