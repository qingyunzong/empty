import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.js';
import { analyze } from '../src/sema.js';

const BASE = `
ingredient a {
  cost 1 CNY/kg;
  stock 1 kg;
}
`;

test('pratt precedence: 1 + 2 * 3 g is 7 g', () => {
  const program = parse(`${BASE}total 1 g + 2 * 3 g; minimize a.grams * a.cost;`);
  const model = analyze(program);
  assert.equal(model.total.n, 7n);
  assert.equal(model.total.d, 1n);
});

test('parentheses override precedence', () => {
  const program = parse(`${BASE}total (1 g + 2 g) * 3; minimize a.grams * a.cost;`);
  const model = analyze(program);
  assert.equal(model.total.n, 9n);
});

test('compound unit CNY/kg parses as (CNY)/kg', () => {
  const program = parse(`${BASE}total 1 kg; step 1 kg; budget 3.2 CNY/kg * 1 kg; minimize a.grams * a.cost;`);
  const model = analyze(program);
  assert.equal(model.budget.n, 16n);
  assert.equal(model.budget.d, 5n);
});

test('implicit unit multiplication binds tighter than division', () => {
  // 3.2 CNY/kg == 0.0032 CNY per gram
  const program = parse(`ingredient a { cost 3.2 CNY/kg; stock 1 kg; } total 1 kg; minimize a.grams * a.cost;`);
  const model = analyze(program);
  const cost = model.ingredients[0].attrs.get('cost').value;
  assert.equal(cost.n, 2n);   // 0.0032 = 2/625 in lowest terms
  assert.equal(cost.d, 625n);
});

test('constraint with comparison parses both sides', () => {
  const program = parse(`${BASE}total 1 kg; constraint a.grams >= 500 g; minimize a.grams * a.cost;`);
  assert.equal(program.constraints.length, 1);
  assert.equal(program.constraints[0].op, '>=');
});

test('duplicate total is a parse error with position', () => {
  assert.throws(
    () => parse(`${BASE}total 1 kg; total 2 kg; minimize a.grams * a.cost;`),
    /duplicate total/,
  );
});
