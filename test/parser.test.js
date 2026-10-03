import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.js';
import { compileProgram } from '../src/engine.js';
import { NetError } from '../src/errors.js';

const constVal = (src, name) => parse(src).consts.get(name);

test('pratt parser respects precedence and unary minus', () => {
  assert.equal(constVal('const X = 1 + 2 * 3;', 'X').v, 7n);
  assert.equal(constVal('const X = (1 + 2) * 3;', 'X').v, 9n);
  assert.equal(constVal('const X = 0 - 4 + 10;', 'X').v, 6n);
  assert.equal(constVal('const X = 20 / 4;', 'X').v, 5n);
});

test('min/max/abs and boolean filters', () => {
  assert.equal(constVal('const X = min(4, 2) + abs(0 - 3);', 'X').v, 5n);
  assert.equal(constVal('const X = max(1, 2);', 'X').v, 2n);
  assert.equal(constVal('const B = 1 < 2 and not (3 > 4);', 'B').v, true);
  assert.equal(constVal('const B = 1 == 2 or 2 != 3;', 'B').v, true);
});

test('percent arithmetic stays integral (basis points)', () => {
  assert.equal(constVal('const X = 10000 * 2.5%;', 'X').v, 250n);
  assert.equal(constVal('const X = 2.5% * 10000;', 'X').v, 250n);
});

test('E_CCY: statically adding different currencies is rejected', () => {
  assert.throws(() => parse('const X = 1 USD + 2 EUR;'), (e) => e.code === 'E_CCY');
  assert.throws(() => parse('const X = min(1 USD, 2 JPY);'), (e) => e.code === 'E_CCY');
});

test('E_PARSE: cross-day const reference is rejected', () => {
  const src = `
day 2026-10-04 { const LIMIT = 5 USD; }
day 2026-10-05 { const OTHER = LIMIT; }
`;
  assert.throws(() => parse(src), (e) => e.code === 'E_PARSE' && /cross-day/.test(e.message));
});

test('day-scoped const is visible inside its own day block', () => {
  const src = `
day 2026-10-04 { const LIMIT = 5 USD; const OTHER = LIMIT; }
`;
  assert.doesNotThrow(() => parse(src));
});

test('E_PARSE: net cannot be used as gross nettable', () => {
  const prog = parse('nettable = net(amount);');
  assert.throws(() => compileProgram(prog), (e) => e.code === 'E_PARSE' && /net/.test(e.message));
});

test('E_PARSE: filter must be boolean', () => {
  const prog = parse('filter amount;');
  assert.throws(() => compileProgram(prog), (e) => e.code === 'E_PARSE');
});

test('E_PARSE: const name colliding with currency code is reserved', () => {
  assert.throws(() => parse('const USD = 1;'), (e) => e.code === 'E_PARSE');
});

test('E_PARSE: duplicate expect cycle up to rotation is E_CYCLE_DUP', () => {
  const src = `
expect cycle @A -> @B -> @C;
expect cycle @C -> @A -> @B;
`;
  assert.throws(() => parse(src), (e) => e.code === 'E_CYCLE_DUP');
});
