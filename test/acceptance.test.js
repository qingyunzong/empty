'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { FormulaStore } = require('../src/versioning');
const { parseFormula } = require('../src/parser');
const { check, enumerateDimensions } = require('../src/checker');
const units = require('../src/units');
const { runSpec } = require('../src/run');

// Acceptance 1: `v=a/t` infers m/s.
test('v=a/t infers m/s', () => {
  const store = new FormulaStore({ a: 'm', t: 's' });
  const r = store.correct('v=a/t');
  assert.equal(r.dimension, 'm/s');
  assert.equal(r.version, 1);
  assert.match(r.certificate, /^[0-9a-f]{64}$/);
});

// Acceptance 2: adding m/s and kg is rejected with position and both dims.
test('m/s + kg rejected with position and both dimensions', () => {
  const store = new FormulaStore({ v: 'm/s', m: 'kg' });
  store.correct('x=v');
  assert.throws(
    () => store.correct('x=v+m'),
    (err) => {
      assert.equal(err.code, 'DIMENSION_MISMATCH');
      assert.equal(err.position, 3); // the '+' in "x=v+m"
      assert.equal(err.column, 4);
      assert.equal(err.left, 'm/s');
      assert.equal(err.right, 'kg');
      assert.match(err.message, /m\/s/);
      assert.match(err.message, /kg/);
      return true;
    }
  );
  // Current version is unchanged after the rejected correction.
  assert.equal(store.current().version, 1);
  assert.equal(store.current().formula, 'x=v');
  assert.equal(store.current().dimension, 'm/s');
});

// Acceptance 3: undo restores old dimension; redo certificate matches.
test('undo restores old dimension, redo certificate identical', () => {
  const store = new FormulaStore({ a: 'm', t: 's' });
  const v1 = store.correct('v=a'); // m
  const v2 = store.correct('v=a/t'); // m/s

  const undone = store.undo();
  assert.equal(undone.version, v1.version);
  assert.equal(undone.dimension, 'm');
  assert.equal(undone.certificate, v1.certificate);

  const redone = store.redo();
  assert.equal(redone.version, v2.version);
  assert.equal(redone.dimension, 'm/s');
  assert.equal(redone.certificate, v2.certificate); // identical to pre-undo certificate
});

// Acceptance 4: enumerate all subexpression dimensions against a table.
test('subexpression dimension enumeration matches expected table', () => {
  const src = 'd=v*t+s0';
  const ast = parseFormula(src);
  const env = new Map([
    ['v', units.parseDimension('m/s')],
    ['t', units.parseDimension('s')],
    ['s0', units.parseDimension('m')],
  ]);
  check(ast, env);
  const rows = enumerateDimensions(ast, src);
  assert.deepEqual(rows, [
    { expression: 'v', dimension: 'm/s' },
    { expression: 't', dimension: 's' },
    { expression: 'v*t', dimension: 'm' },
    { expression: 's0', dimension: 'm' },
    { expression: 'v*t+s0', dimension: 'm' },
    { expression: 'd=v*t+s0', dimension: 'm' },
  ]);
});

// Errors: unknown variable, unbalanced parentheses, trailing junk.
test('unknown variable is an error and keeps current version', () => {
  const store = new FormulaStore({ a: 'm' });
  store.correct('x=a');
  assert.throws(
    () => store.correct('x=b'),
    (err) => err.code === 'UNKNOWN_VARIABLE' && err.variable === 'b' && err.column === 3
  );
  assert.equal(store.current().formula, 'x=a');
});

test('parenthesis errors are reported with position', () => {
  const store = new FormulaStore({ a: 'm', b: 'm' });
  assert.throws(() => store.correct('x=(a+b'), (err) => err.code === 'PARSE_ERROR');
  assert.throws(
    () => store.correct('x=a+b)'),
    (err) => err.code === 'PARSE_ERROR' && /unmatched "\)"/.test(err.message) && err.position === 5
  );
  assert.equal(store.current(), null); // no version ever committed
});

test('comparison requires equal dimensions, result dimensionless', () => {
  const store = new FormulaStore({ a: 'm', b: 'm', t: 's' });
  assert.equal(store.correct('ok=a<b').dimension, '1');
  assert.throws(() => store.correct('bad=a<t'), (err) => err.code === 'DIMENSION_MISMATCH');
});

test('functions declare parameter dimensions', () => {
  const store = new FormulaStore({ x: 'm', r: '1' });
  assert.equal(store.correct('y=sin(r)').dimension, '1');
  assert.throws(
    () => store.correct('y=sin(x)'),
    (err) => err.code === 'DIMENSION_MISMATCH' && err.expected === '1' && err.actual === 'm'
  );
  assert.equal(store.correct('w=abs(x)').dimension, 'm');
});

test('multiply/divide combine exponent vectors', () => {
  const store = new FormulaStore({ m: 'kg', a: 'm/s^2', v: 'm/s', t: 's' });
  assert.equal(store.correct('f=m*a').dimension, 'N');
  assert.equal(store.correct('f2=m*v/t').dimension, 'N');
});

test('certificates are deterministic and differ across formulas', () => {
  const a = new FormulaStore({ a: 'm', t: 's' });
  const b = new FormulaStore({ a: 'm', t: 's' });
  const r1 = a.correct('v=a/t');
  const r2 = b.correct('v=a/t');
  assert.equal(r1.certificate, r2.certificate);
  const r3 = b.correct('v=a*a/t');
  assert.notEqual(r3.certificate, r2.certificate);
});

// CLI spec end-to-end (same code path as src/cli.js): JSON in, JSON out.
test('CLI spec processes JSON commands and reports errors without state change', () => {
  const spec = {
    variables: { a: 'm', t: 's', m: 'kg' },
    commands: [
      { op: 'correct', formula: 'v=a/t' },
      { op: 'correct', formula: 'bad=v+m' },
      { op: 'status' },
      { op: 'correct', formula: 'v=a*a/t' },
      { op: 'undo' },
      { op: 'redo' },
      { op: 'enumerate' },
    ],
  };
  const out = runSpec(spec);

  assert.equal(out.ok, true);
  const [c1, c2, c3, c4, c5, c6, c7] = out.results;

  assert.equal(c1.ok, true);
  assert.equal(c1.dimension, 'm/s');

  assert.equal(c2.ok, false);
  assert.equal(c2.error.code, 'DIMENSION_MISMATCH');
  assert.equal(c2.error.left, 'm/s');
  assert.equal(c2.error.right, 'kg');
  assert.equal(c2.error.position, 5);

  assert.equal(c3.current.version, 1); // unchanged after failed correct
  assert.equal(c3.current.dimension, 'm/s');

  assert.equal(c4.ok, true);
  assert.equal(c4.dimension, 'L^2*T^-1');

  assert.equal(c5.current.dimension, 'm/s'); // undo restores old dimension
  assert.equal(c6.current.certificate, c4.certificate); // redo certificate matches

  assert.equal(c7.ok, true);
  assert.ok(c7.subexpressions.some((r) => r.expression === 'a*a' && r.dimension === 'L^2'));
});
