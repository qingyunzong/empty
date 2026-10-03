import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.js';
import { checkExpr, TypeCheckError } from '../src/typecheck.js';
import { compileExpr, runProgram } from '../src/bytecode.js';
import { Interpreter } from '../src/interp.js';
import { Model } from '../src/model.js';

function evalExpr(src, ctx = { overlap: () => 0, total: () => 0 }) {
  const stmt = parse(`constraint ${src};`)[0];
  const lines = new Map([['L1', 0], ['L2', 1]]);
  const t = checkExpr(stmt.expr, (n) => (lines.has(n) ? 'line' : null));
  const prog = compileExpr(stmt.expr, (n) => lines.get(n));
  return { type: t, value: runProgram(prog, ctx) };
}

test('pratt parser respects precedence and associativity', () => {
  assert.equal(evalExpr('1 + 2 * 3').value.v, 7);
  assert.equal(evalExpr('(1 + 2) * 3').value.v, 9);
  assert.equal(evalExpr('10 - 4 - 3').value.v, 3);
  assert.equal(evalExpr('20 / 5 / 2').value.v, 2);
  assert.equal(evalExpr('1 + 2 == 3 and not false').value.v, true);
  assert.equal(evalExpr('1 < 2 or 2 < 1 and false').value.v, true);
  assert.equal(evalExpr('-3 + 5').value.v, 2);
});

test('static types: instants, durations, lines', () => {
  assert.equal(evalExpr('@2026-01-05T08:00 + 2h').type, 'instant');
  assert.equal(evalExpr('@2026-01-05T10:00 - @2026-01-05T08:00').type, 'duration');
  assert.equal(evalExpr('2h * 3').type, 'duration');
  assert.equal(evalExpr('3 * 2h').type, 'duration');
  assert.equal(evalExpr('6h / 2').type, 'duration');
  assert.equal(evalExpr('overlap(L1) + 1 <= 2').type, 'bool');
  assert.equal(evalExpr('total(L1) <= 8h').type, 'bool');
  assert.equal(evalExpr('L1 == L2').type, 'bool');
  assert.throws(() => evalExpr('1 + 2h'), TypeCheckError);
  assert.throws(() => evalExpr('1 < 2h'), TypeCheckError);
  assert.throws(() => evalExpr('1h < @2026-01-05T08:00'), TypeCheckError);
  assert.throws(() => evalExpr('overlap(1)'), TypeCheckError);
  assert.throws(() => evalExpr('overlap(L9)'), TypeCheckError);
  assert.throws(() => evalExpr('true and 1'), TypeCheckError);
});

test('bytecode VM evaluates resource constraints with context', () => {
  const ctx = { overlap: (id) => (id === 0 ? 2 : 1), total: (id) => (id === 0 ? 300 : 60) };
  assert.equal(evalExpr('overlap(L1) <= 2 and total(L1) <= 5h', ctx).value.v, true);
  assert.equal(evalExpr('overlap(L1) + overlap(L2) <= 2', ctx).value.v, false);
  assert.equal(evalExpr('total(L2) == 1h', ctx).value.v, true);
});

test('templates have lexical scope: later declarations are invisible', () => {
  const interp = new Interpreter(new Model());
  interp.runSource(`
    line L1;
    template t(n: name, l: line) { job n { line: l; duration: 1h; } }
    line L2;
  `);
  assert.throws(() => interp.runSource(`
    template bad(n: name) { job n { line: L3; duration: 1h; } }
    line L3;
    bad(J1);
  `), /lexical scope/);
});

test('template parameters shadow outer names', () => {
  const interp = new Interpreter(new Model());
  interp.runSource(`
    line L1, L2;
    template t(L1: line, n: name) { job n { line: L1; duration: 1h; priority: 1; } }
    t(L2, J9);
  `);
  assert.equal(interp.model.jobs.get('J9').line, 'L2');
});

test('template call type checking', () => {
  const interp = new Interpreter(new Model());
  interp.runSource(`
    line L1;
    template t(n: name, l: line, d: duration, p: int) {
      job n { line: l; duration: d; priority: p; }
    }
  `);
  assert.throws(() => interp.runSource('t(J1, L1, 2, 3);'), TypeCheckError);
  assert.throws(() => interp.runSource('t(J1, L1, 2h);'), TypeCheckError);
  assert.throws(() => interp.runSource('t(J1, L2, 2h, 3);'), TypeCheckError);
  interp.runSource('t(J1, L1, 2h, 3);');
  assert.equal(interp.model.jobs.get('J1').duration, 120);
  assert.equal(interp.model.jobs.get('J1').priority, 3);
});

test('duplicate declarations and unknown statements are rejected', () => {
  const interp = new Interpreter(new Model());
  interp.runSource('line L1;');
  assert.throws(() => interp.runSource('line L1;'), /duplicate/);
  assert.throws(() => interp.runSource('frobnicator;'), /unknown statement/);
});
