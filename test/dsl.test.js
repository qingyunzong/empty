import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScript, parseConstraintExpr } from '../src/parser.js';
import { typeOf, TypeError_ } from '../src/types.js';
import { compile, run, Validator } from '../src/bytecode.js';
import { Interpreter, DslError } from '../src/dsl.js';
import { Store } from '../src/store.js';

const LINES = { lines: [{ name: 'A', shifts: [[480, 960]], maintenance: [] }, { name: 'B', shifts: [[480, 960]], maintenance: [] }], constraints: [] };

function interp(env = LINES) {
  return new Interpreter({ gen: 0, env: structuredClone(env), jobs: [] }, null);
}

test('Pratt parser respects precedence and associativity', () => {
  // 1 + 2 == 3 && 2 < 3 || 1 == 2  ==  ((1+2)==3 && 2<3) || (1==2)  -> true
  const e = parseConstraintExpr('1 + 2 == 3 && 2 < 3 || 1 == 2');
  const p = compile(e, new Map());
  assert.equal(run(p, { counts: [], loads: [] }), true);
  // 10 - 3 - 2 == 5 (left assoc)
  const e2 = parseConstraintExpr('10 - 3 - 2 == 5');
  assert.equal(run(compile(e2, new Map()), { counts: [], loads: [] }), true);
});

test('static type checking of instants, durations and lines', () => {
  const tenv = new Map([['A', 'Line'], ['B', 'Line']]);
  assert.equal(typeOf(parseConstraintExpr('@2026-01-01T08:00 + 2h'), tenv), 'Inst');
  assert.equal(typeOf(parseConstraintExpr('@2026-01-02T00:00 - @2026-01-01T00:00'), tenv), 'Dur');
  assert.equal(typeOf(parseConstraintExpr('load(A) + 30m <= 9h'), tenv), 'Bool');
  assert.equal(typeOf(parseConstraintExpr('count(A) >= 1 && count(B) >= 1'), tenv), 'Bool');
  assert.throws(() => typeOf(parseConstraintExpr('count(A) <= 8h'), tenv), TypeError_); // Int vs Dur
  assert.throws(() => typeOf(parseConstraintExpr('load(A) < @2026-01-01T00:00'), tenv), TypeError_); // Dur vs Inst
  assert.throws(() => typeOf(parseConstraintExpr('count(1) > 0'), tenv), TypeError_); // Int not Line
  assert.throws(() => typeOf(parseConstraintExpr('count(A) && count(B)'), tenv), TypeError_); // Int not Bool
});

test('bytecode evaluates count/load against schedule context', () => {
  const tenv = new Map([['A', 'Line'], ['B', 'Line']]);
  const e = parseConstraintExpr('count(A) + count(B) <= 4 && load(A) <= 8h');
  assert.equal(typeOf(e, tenv), 'Bool');
  const p = compile(e, new Map([['A', 0], ['B', 1]]));
  assert.deepEqual(p.linesUsed.sort(), ['A', 'B']);
  assert.equal(run(p, { counts: [2, 1], loads: [300, 60] }), true);
  assert.equal(run(p, { counts: [2, 3], loads: [300, 60] }), false);
});

test('incremental validator only re-evaluates constraints on changed lines', () => {
  const v = new Validator();
  const lineIndex = new Map([['A', 0], ['B', 1]]);
  v.setConstraint('ca', compile(parseConstraintExpr('count(A) <= 2'), lineIndex), ['A']);
  v.setConstraint('cb', compile(parseConstraintExpr('count(B) <= 2'), lineIndex), ['B']);
  const ctx = { counts: [1, 1], loads: [0, 0] };
  assert.equal(v.validate(ctx, ['A', 'B'], null).ok, true);
  assert.equal(v.evaluated, 2);
  v.validate(ctx, ['A', 'B'], ['A']);
  assert.equal(v.evaluated, 3); // only ca re-evaluated
  v.validate(ctx, ['A', 'B'], ['B']);
  assert.equal(v.evaluated, 4); // only cb re-evaluated
});

test('templates have lexical scope: definition-site bindings win', () => {
  const it = interp();
  it.execAll(parseScript(`
let base = 10
template t(p) { duration 30m priority p + base }
let base = 99
job J1 = t(1)
commit
`));
  const j1 = it.jobs.find((j) => j.id === 'J1');
  assert.equal(j1.priority, 11); // 1 + 10, not 1 + 99
});

test('template parameters shadow outer bindings', () => {
  const it = interp();
  it.execAll(parseScript(`
let p = 100
template t(p) { duration 30m priority p }
job J1 = t(7)
commit
`));
  assert.equal(it.jobs.find((j) => j.id === 'J1').priority, 7);
});

test('unknown template / wrong arity are errors', () => {
  const it = interp();
  assert.throws(() => it.execAll(parseScript('job J1 = nope(1)')), DslError);
  const it2 = interp();
  assert.throws(
    () => it2.execAll(parseScript('template t(p) { duration 30m priority p }\njob J1 = t(1, 2)')),
    DslError);
});

test('constraint referencing a let-bound name is rejected (constraints are self-contained)', () => {
  const it = interp();
  assert.throws(
    () => it.execAll(parseScript('let k = 2\nconstraint c = count(A) <= k')),
    TypeError_);
});

test('infeasible job (longer than any shift) raises InfeasibleError at commit', () => {
  const it = interp();
  assert.throws(
    () => it.execAll(parseScript('job J1 { duration 10h priority 1 }\ncommit')),
    /cannot be placed/);
});

test('constraint violation at commit raises InfeasibleError', () => {
  const it = interp();
  assert.throws(
    () => it.execAll(parseScript(`
constraint c = count(A) <= 0
job J1 { duration 30m priority 1 lines A }
commit
`)), /constraints violated: c/);
});
