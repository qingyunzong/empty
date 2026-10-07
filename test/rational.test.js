'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Rat, parseRat } = require('../src/rational');
const { solve } = require('../src/linsolve');

test('rational arithmetic stays exact and reduced', () => {
  const a = new Rat(1n, 3n);
  const b = new Rat(1n, 6n);
  assert.equal(a.add(b).toString(), '1/2');
  assert.equal(a.sub(b).toString(), '1/6');
  assert.equal(a.mul(b).toString(), '1/18');
  assert.equal(a.div(b).toString(), '2');
  assert.equal(new Rat(4n, -8n).toString(), '-1/2');
  assert.equal(new Rat(-7n, 1n).toString(), '-7');
  assert.equal(new Rat(0n, 5n).toString(), '0');
  assert.equal(new Rat(2n, 4n).cmp(new Rat(1n, 2n)), 0);
  assert.equal(new Rat(1n, 3n).cmp(new Rat(1n, 2n)), -1);
});

test('parseRat accepts ints, strings, pairs, objects', () => {
  assert.equal(parseRat(5).toString(), '5');
  assert.equal(parseRat('3/4').toString(), '3/4');
  assert.equal(parseRat('-2').toString(), '-2');
  assert.equal(parseRat([6, 9]).toString(), '2/3');
  assert.equal(parseRat({ num: 10, den: 4 }).toString(), '5/2');
  assert.throws(() => parseRat(1.5));
  assert.throws(() => parseRat('x'));
});

test('exact linear solve', () => {
  // 2x + y = 5 ; x - y = 1  ->  x = 2, y = 1
  const A = [[new Rat(2n), new Rat(1n)], [new Rat(1n), new Rat(-1n)]];
  const b = [new Rat(5n), new Rat(1n)];
  const x = solve(A, b);
  assert.deepEqual(x.map(String), ['2', '1']);
  // singular
  const S = [[new Rat(1n), new Rat(1n)], [new Rat(2n), new Rat(2n)]];
  assert.equal(solve(S, b), null);
  // fractional solution: 2x = 3 -> x = 3/2
  const [xf] = solve([[new Rat(2n)]], [new Rat(3n)]);
  assert.equal(xf.toString(), '3/2');
});
