import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lex, Diagnostic } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { check } from '../src/check.js';

const checkSrc = (src) => check(parse(lex(src, 't.dsl'), 't.dsl'), 't.dsl');
const fails = (src, pattern) =>
  assert.throws(
    () => checkSrc(src),
    (e) => e instanceof Diagnostic && pattern.test(e.message) && e.line >= 1 && e.col >= 1,
  );

const BASE = `
ingredient A {
  cost: 1 CNY / 1 kg;
  stock: 100 g;
}
target: 100 g;
minimize cost;
`;

test('accepts a minimal valid program', () => {
  const model = checkSrc(BASE);
  assert.equal(model.targetG, 100);
  assert.equal(model.ingredients.length, 1);
  assert.equal(model.ingredients[0].costMicroPerG, 1000);
});

test('rejects adding kg and ppm (dimension mismatch)', () => {
  fails(
    BASE.replace('stock: 100 g;', 'stock: 1 kg + 5 ppm;'),
    /dimension mismatch/,
  );
});

test('rejects unsupported compound dimensions', () => {
  fails(`${BASE}constraint cost * cost <= 1 CNY;`, /unsupported dimension/);
});

test('rejects circular macro expansion', () => {
  fails(
    `macro a = b + 1 g;\nmacro b = a + 1 g;\n` +
      BASE.replace('stock: 100 g;', 'stock: a;'),
    /circular macro expansion/,
  );
});

test('rejects undeclared ingredient references', () => {
  fails(`${BASE}constraint grams(Ghost) <= 1 g;`, /undeclared ingredient 'Ghost'/);
});

test('rejects unknown names in constraints', () => {
  fails(`${BASE}constraint mystery >= 1 ppm;`, /unknown name 'mystery'/);
});

test('macros are lexically scoped: ingredient-local macro stays local', () => {
  const src = `
ingredient A {
  macro s = 100 g;
  cost: 1 CNY / 1 kg;
  stock: s;
}
ingredient B {
  cost: 1 CNY / 1 kg;
  stock: s;
}
target: 100 g;
minimize cost;
`;
  fails(src, /unknown name 's'/);
});

test('inner macro shadows outer macro (lexical scoping)', () => {
  const src = `
macro s = 10 g;
ingredient A {
  macro s = 60 g;
  cost: 1 CNY / 1 kg;
  stock: s;
}
ingredient B {
  cost: 1 CNY / 1 kg;
  stock: s;
}
target: 60 g;
minimize cost;
`;
  const model = checkSrc(src);
  const stocks = Object.fromEntries(model.ingredients.map((i) => [i.name, i.stockG]));
  assert.deepEqual(stocks, { A: 60, B: 10 });
});

test('kg and CNY convert to base units', () => {
  const model = checkSrc(`
ingredient A {
  cost: 2 CNY / 1 kg;
  stock: 0.5 kg;
}
target: 0.1 kg;
step: 20 g;
budget: 1 CNY;
minimize cost;
`);
  assert.equal(model.targetG, 100);
  assert.equal(model.ingredients[0].stockG, 500);
  assert.equal(model.ingredients[0].costMicroPerG, 2000);
  assert.equal(model.budgetMicro, 1_000_000);
});

test('rejects duplicate ingredients and missing properties', () => {
  fails(`${BASE}${BASE}`, /duplicate ingredient 'A'/);
  fails(
    `ingredient A { stock: 10 g; }\ntarget: 10 g;\nminimize cost;`,
    /missing 'cost'/,
  );
});
