import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lex } from '../src/lexer.js';
import { parse } from '../src/parser.js';

const parseSrc = (src) => parse(lex(src));

test('Pratt precedence: * binds tighter than +', () => {
  const prog = parseSrc('target: 1 kg + 2 g * 3;');
  const e = prog.body[0].expr;
  assert.equal(e.kind, 'bin');
  assert.equal(e.op, '+');
  assert.equal(e.right.kind, 'bin');
  assert.equal(e.right.op, '*');
});

test('parentheses override precedence', () => {
  const prog = parseSrc('target: (1 kg + 2 g) * 3;');
  const e = prog.body[0].expr;
  assert.equal(e.op, '*');
  assert.equal(e.left.op, '+');
});

test('parses content-range constraints', () => {
  const prog = parseSrc('constraint protein in [100 ppm, 200 ppm];');
  const c = prog.body[0];
  assert.equal(c.kind, 'range');
  assert.equal(c.indicator, 'protein');
  assert.equal(c.lo.value, 100);
  assert.equal(c.hi.unit, 'ppm');
});

test('parses comparison constraints and cost expressions', () => {
  const prog = parseSrc('constraint cost * 2 <= 3 CNY;');
  const c = prog.body[0];
  assert.equal(c.kind, 'cmp');
  assert.equal(c.op, '<=');
  assert.equal(c.left.kind, 'bin');
});

test('parses ingredient blocks with indicators and macros', () => {
  const prog = parseSrc(`
    ingredient A {
      macro half = 50 g;
      cost: 1 CNY / 1 kg;
      stock: half;
      allergen: 5 ppm;
      indicator protein: 1000 ppm;
    }
  `);
  const ing = prog.body[0];
  assert.equal(ing.kind, 'ingredient');
  assert.deepEqual(
    ing.items.map((i) => (i.kind === 'macro' ? 'macro' : i.prop)),
    ['macro', 'cost', 'stock', 'allergen', 'indicator'],
  );
});
