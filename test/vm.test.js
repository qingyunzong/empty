import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/vm.js';
import { pipeline } from './helpers.js';

test('VM arithmetic opcodes', () => {
  const code = [
    ['PUSH', 6],
    ['PUSH', 2],
    ['DIV'],
    ['PUSH', 4],
    ['MUL'],
    ['PUSH', 1],
    ['SUB'],
    ['NEG'],
  ];
  assert.equal(run(code, []), -11);
});

test('VM comparison and range opcodes', () => {
  assert.equal(run([['PUSH', 5], ['PUSH', 5], ['LE']], []), 1);
  assert.equal(run([['PUSH', 5], ['PUSH', 4], ['EQ']], []), 0);
  assert.equal(run([['PUSH', 7], ['RNG', 1, 10]], []), 1);
  assert.equal(run([['PUSH', 70], ['RNG', 1, 10]], []), 0);
});

test('compiled objective matches hand-computed cost', () => {
  const prog = pipeline(`
ingredient A { cost: 4 CNY / 1 kg; stock: 100 g; }
ingredient B { cost: 6 CNY / 1 kg; stock: 100 g; }
target: 100 g;
step: 50 g;
minimize cost;
`);
  assert.equal(run(prog.objectiveCode, [50, 50]), 50 * 4000 + 50 * 6000);
  assert.equal(run(prog.allergenCode, [50, 50]), 0);
});
