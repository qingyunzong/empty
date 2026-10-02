import test from 'node:test';
import assert from 'node:assert/strict';
import { FormulaStore } from '../src/store.js';
import { FormulaError } from '../src/errors.js';
import { parse } from '../src/parser.js';
import { check, subexpressionTable } from '../src/checker.js';
import { parseDimension } from '../src/dimensions.js';
import { run } from '../src/cli.js';

test('acceptance 1: v=a/t infers m/s', () => {
  const store = new FormulaStore({ a: 'm', t: 's' });
  const r = store.correct('v=a/t');
  assert.equal(r.dimension, 'm/s');
  assert.equal(r.version, 1);
  assert.match(r.certificate, /^[0-9a-f]{64}$/);
});

test('acceptance 2: m/s + kg rejected with position and both dimensions', () => {
  const store = new FormulaStore({ u: 'm/s', m: 'kg' });
  assert.throws(
    () => store.correct('u+m'),
    (err) => {
      assert.ok(err instanceof FormulaError);
      assert.equal(err.code, 'DIM_MISMATCH');
      assert.deepEqual(err.details.position, { start: 0, end: 3 });
      assert.equal(err.details.left, 'm/s');
      assert.equal(err.details.right, 'kg');
      return true;
    },
  );
  assert.equal(store.current(), null, 'failed correct leaves no version');
});

test('acceptance 3: undo restores old dimension, redo certificate matches', () => {
  const store = new FormulaStore({ a: 'm', t: 's' });
  const v1 = store.correct('v=a/t');
  const v2 = store.correct('v=a*2');
  assert.equal(v2.dimension, 'm');

  const undone = store.undo();
  assert.equal(undone.version, v1.version);
  assert.equal(undone.dimension, 'm/s');
  assert.equal(undone.certificate, v1.certificate);

  const redone = store.redo();
  assert.equal(redone.version, v2.version);
  assert.equal(redone.dimension, 'm');
  assert.equal(redone.certificate, v2.certificate, 'redo certificate equals pre-undo certificate');
});

test('acceptance 4: subexpression dimension enumeration table', () => {
  const env = { v: parseDimension('m/s'), t: parseDimension('s'), a: parseDimension('m/s^2') };
  const source = 'v*t+a*t^2/2';
  const ast = parse(source);
  check(ast, env);
  const table = subexpressionTable(ast, source);
  const expected = [
    { expr: 'v*t+a*t^2/2', dim: 'm' },
    { expr: 'v*t', dim: 'm' },
    { expr: 'v', dim: 'm/s' },
    { expr: 't', dim: 's' },
    { expr: 'a*t^2/2', dim: 'm' },
    { expr: 'a*t^2', dim: 'm' },
    { expr: 'a', dim: 'm/s^2' },
    { expr: 't^2', dim: 's^2' },
    { expr: 't', dim: 's' },
    { expr: '2', dim: '1' },
    { expr: '2', dim: '1' },
  ];
  assert.deepEqual(table, expected);
});

test('paren errors keep current version unchanged', () => {
  const store = new FormulaStore({ a: 'm', t: 's' });
  store.correct('a/t');
  const before = store.current();
  for (const bad of ['(a+t', 'a+t)', '((a)', 'a*(t+'] ) {
    assert.throws(() => store.correct(bad), (err) => err.code === 'PARSE_PAREN');
  }
  assert.deepEqual(store.current(), before);
  assert.equal(store.versions.length, 1);
});

test('unknown variable is an error and version stays unchanged', () => {
  const store = new FormulaStore({ a: 'm' });
  store.correct('a*2');
  const before = store.current();
  assert.throws(
    () => store.correct('a+b'),
    (err) => err.code === 'UNKNOWN_VARIABLE'
      && err.details.variable === 'b'
      && err.details.position.start === 2,
  );
  assert.deepEqual(store.current(), before);
});

test('comparison requires equal dimensions, result dimensionless', () => {
  const store = new FormulaStore({ a: 'm', b: 'm', t: 's' });
  assert.equal(store.correct('a<b').dimension, '1');
  assert.throws(() => store.correct('a<t'), (err) => err.code === 'DIM_MISMATCH');
});

test('function parameter dimensions are enforced', () => {
  const store = new FormulaStore({ t: 's', x: '1' });
  assert.equal(store.correct('sin(x)+1').dimension, '1');
  assert.throws(
    () => store.correct('sin(t)'),
    (err) => err.code === 'DIM_FUNCTION_ARG' && err.details.expected === '1' && err.details.actual === 's',
  );
  assert.equal(store.correct('sqrt(t^2)').dimension, 's');
  assert.throws(() => store.correct('sqrt(t)'), (err) => err.code === 'DIM_FUNCTION_ARG');
  assert.throws(() => store.correct('foo(t)'), (err) => err.code === 'UNKNOWN_FUNCTION');
});

test('AST is immutable after correct', () => {
  const store = new FormulaStore({ a: 'm', t: 's' });
  store.correct('a/t');
  const ast = store.currentAst();
  assert.ok(Object.isFrozen(ast));
  assert.ok(Object.isFrozen(ast.left));
  assert.throws(() => { ast.op = '*'; }, TypeError);
});

test('certificate is deterministic for same formula and env', () => {
  const a = new FormulaStore({ a: 'm', t: 's' }).correct('a/t').certificate;
  const b = new FormulaStore({ t: 's', a: 'm' }).correct('a/t').certificate;
  assert.equal(a, b);
});

test('undo/redo boundaries raise errors', () => {
  const store = new FormulaStore({ a: 'm' });
  assert.throws(() => store.undo(), (err) => err.code === 'NOTHING_TO_UNDO');
  store.correct('a');
  assert.throws(() => store.redo(), (err) => err.code === 'NOTHING_TO_REDO');
});

test('CLI end-to-end: correct, reject, undo, redo', () => {
  const out = run({
    variables: { a: 'm', t: 's', m: 'kg' },
    commands: [
      { op: 'correct', formula: 'v=a/t' },
      { op: 'correct', formula: 'v=a/t+m' },
      { op: 'correct', formula: 'v=a*2' },
      { op: 'undo' },
      { op: 'redo' },
    ],
  });
  const [r1, r2, r3, r4, r5] = out.results;

  assert.equal(r1.ok, true);
  assert.equal(r1.dimension, 'm/s');
  assert.equal(r1.version, 1);

  assert.equal(r2.ok, false);
  assert.equal(r2.error.code, 'DIM_MISMATCH');
  assert.equal(r2.error.left, 'm/s');
  assert.equal(r2.error.right, 'kg');
  assert.deepEqual(r2.error.position, { start: 2, end: 7 });
  assert.equal(r2.version, 1, 'failed correct keeps current version');

  assert.equal(r3.ok, true);
  assert.equal(r3.dimension, 'm');
  assert.equal(r3.version, 2);

  assert.equal(r4.ok, true);
  assert.equal(r4.dimension, 'm/s');
  assert.equal(r4.certificate, r1.certificate);

  assert.equal(r5.ok, true);
  assert.equal(r5.dimension, 'm');
  assert.equal(r5.certificate, r3.certificate, 'redo certificate equals pre-undo certificate');
});

test('CLI reports paren and unknown-variable errors', () => {
  const out = run({
    variables: { a: 'm' },
    commands: [
      { op: 'correct', formula: '(a*2' },
      { op: 'correct', formula: 'a+z' },
    ],
  });
  assert.equal(out.results[0].ok, false);
  assert.equal(out.results[0].error.code, 'PARSE_PAREN');
  assert.equal(out.results[1].ok, false);
  assert.equal(out.results[1].error.code, 'UNKNOWN_VARIABLE');
});
