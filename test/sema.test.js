import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.js';
import { analyze } from '../src/sema.js';
import { Diagnostic } from '../src/lexer.js';

const BASE = `ingredient a { cost 1 CNY/kg; stock 1 kg; protein 100000 ppm; }`;

function pipelineErr(src) {
  try {
    analyze(parse(src, 'test.dsl'));
    return null;
  } catch (e) {
    if (e instanceof Diagnostic) return e;
    throw e;
  }
}

test('kg + ppm is a dimension error naming both units', () => {
  const e = pipelineErr(`${BASE}\ntotal 1 kg + 5 ppm;\nminimize a.grams * a.cost;`);
  assert.ok(e, 'expected a diagnostic');
  assert.match(e.message, /dimension mismatch/);
  assert.match(e.message, /'kg'/);
  assert.match(e.message, /'ppm'/);
  assert.equal(e.line, 2);
});

test('g and kg are compatible (same dimension)', () => {
  const model = analyze(parse(`${BASE}\ntotal 500 g + 1 kg;\nminimize a.grams * a.cost;`));
  assert.equal(model.total.n, 1500n);
});

test('undeclared ingredient is rejected with position', () => {
  const e = pipelineErr(`${BASE}\ntotal 1 kg;\nconstraint ghost.grams >= 1 g;\nminimize a.grams * a.cost;`);
  assert.ok(e);
  assert.match(e.message, /undeclared ingredient 'ghost'/);
  assert.equal(e.line, 3);
});

test('undeclared attribute is rejected', () => {
  const e = pipelineErr(`${BASE}\ntotal 1 kg;\nconstraint a.fat <= 1 g;\nminimize a.grams * a.cost;`);
  assert.ok(e);
  assert.match(e.message, /has no attribute 'fat'/);
});

test('macro cycle is detected during expansion', () => {
  const src = `${BASE}
macro x = y + 1;
macro y = x + 1;
total 1 kg;
constraint a.grams >= x * 1 g;
minimize a.grams * a.cost;`;
  const e = pipelineErr(src);
  assert.ok(e);
  assert.match(e.message, /macro expansion cycle detected: x -> y -> x/);
  assert.equal(e.line, 5);
});

test('self-referential macro is a cycle', () => {
  const src = `${BASE}
macro loop = loop * 2;
total 1 kg;
constraint a.grams >= loop * 1 g;
minimize a.grams * a.cost;`;
  const e = pipelineErr(src);
  assert.ok(e);
  assert.match(e.message, /cycle/);
});

test('macros are lexically scoped: bodies capture their definition scope', () => {
  const src = `
macro x = 2;
macro f = x * 3;
ingredient a {
  cost 1 CNY/kg;
  stock 1 kg;
  macro x = 5;
  inner x;
  captured f;
}
total 1 kg;
minimize a.grams * a.cost;`;
  const model = analyze(parse(src));
  const attrs = model.ingredients[0].attrs;
  assert.equal(attrs.get('inner').value.n, 5n, 'inner scope shadows outer x');
  assert.equal(attrs.get('captured').value.n, 6n, 'f captured outer x=2, not inner x=5');
});

test('duplicate macro in the same scope is rejected', () => {
  const e = pipelineErr(`macro x = 1;\nmacro x = 2;\n${BASE}\ntotal 1 kg;\nminimize a.grams * a.cost;`);
  assert.ok(e);
  assert.match(e.message, /duplicate macro 'x'/);
  assert.equal(e.line, 2);
});

test('cost attribute must be currency per mass', () => {
  const e = pipelineErr(`ingredient a { cost 3 g; stock 1 kg; }\ntotal 1 kg;\nminimize a.grams * a.cost;`);
  assert.ok(e);
  assert.match(e.message, /attribute 'cost'/);
});

test('objective must be a currency expression', () => {
  const e = pipelineErr(`${BASE}\ntotal 1 kg;\nminimize a.grams;`);
  assert.ok(e);
  assert.match(e.message, /objective must have dimension 'currency'/);
});

test('constraint sides must share a dimension', () => {
  const e = pipelineErr(`${BASE}\ntotal 1 kg;\nconstraint a.grams >= 3 CNY;\nminimize a.grams * a.cost;`);
  assert.ok(e);
  assert.match(e.message, /dimension mismatch in constraint/);
});

test('content constraint with ppm ratio type-checks', () => {
  const src = `${BASE}
total 1 kg;
constraint a.protein * a.grams >= 80000 ppm * a.grams;
minimize a.grams * a.cost;`;
  const model = analyze(parse(src));
  assert.equal(model.constraints.length, 1);
});
