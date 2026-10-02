import test from 'node:test';
import assert from 'node:assert/strict';
import { compileRule } from '../src/engine.js';
import { run } from '../src/vm.js';

const SOURCE = `
rule "sampling" version 1 {
  param batch_size: quantity
  param sampled: quantity
  param defects: quantity
  param severity: level

  const max_defects: quantity = 2
  const min_sample: quantity = 5

  when defects > max_defects or severity >= critical => REJECT
  when sampled >= min_sample and defects <= max_defects => ACCEPT
  otherwise => CONTINUE
}
`;

const { program } = compileRule(SOURCE, 'test.dsl');
const decide = (ctx) => run(program, ctx);

test('ACCEPT path: enough samples, defects within threshold', () => {
  assert.equal(decide({ batch_size: 100, sampled: 5, defects: 0, severity: 'minor' }), 'ACCEPT');
  assert.equal(decide({ batch_size: 100, sampled: 8, defects: 2, severity: 'major' }), 'ACCEPT');
});

test('REJECT path: too many defects or critical severity', () => {
  assert.equal(decide({ batch_size: 100, sampled: 3, defects: 3, severity: 'minor' }), 'REJECT');
  assert.equal(decide({ batch_size: 100, sampled: 1, defects: 0, severity: 'critical' }), 'REJECT');
});

test('CONTINUE path: legal pending state, not an error', () => {
  assert.equal(decide({ batch_size: 100, sampled: 0, defects: 0, severity: 'minor' }), 'CONTINUE');
  assert.equal(decide({ batch_size: 100, sampled: 4, defects: 2, severity: 'major' }), 'CONTINUE');
});

test('boundary: defects exactly equal to the threshold accepts', () => {
  const at = decide({ batch_size: 100, sampled: 5, defects: 2, severity: 'minor' });
  const above = decide({ batch_size: 100, sampled: 5, defects: 3, severity: 'minor' });
  assert.equal(at, 'ACCEPT');
  assert.equal(above, 'REJECT');
});

test('boundary: sampled exactly at min_sample accepts', () => {
  assert.equal(decide({ batch_size: 100, sampled: 5, defects: 1, severity: 'minor' }), 'ACCEPT');
  assert.equal(decide({ batch_size: 100, sampled: 4, defects: 1, severity: 'minor' }), 'CONTINUE');
});

test('exact ratio arithmetic: 1/3 vs 33% and the 34% boundary', () => {
  const { program: p } = compileRule(`
rule "r" version 1 {
  param a: quantity
  param b: quantity
  when a / b > 33% => REJECT
  otherwise => ACCEPT
}
`, 'test.dsl');
  assert.equal(run(p, { a: 33, b: 100 }), 'ACCEPT'); // exactly 33%: not above
  assert.equal(run(p, { a: 1, b: 3 }), 'REJECT'); // 1/3 > 33% exactly
  assert.equal(run(p, { a: 34, b: 100 }), 'REJECT');

  const { program: p34 } = compileRule(`
rule "r" version 1 {
  param a: quantity
  param b: quantity
  when a / b > 34% => REJECT
  otherwise => ACCEPT
}
`, 'test.dsl');
  assert.equal(run(p34, { a: 34, b: 100 }), 'ACCEPT'); // boundary: equal accepts
  assert.equal(run(p34, { a: 35, b: 100 }), 'REJECT');
});

test('short-circuit avoids division by zero', () => {
  const { program: p } = compileRule(`
rule "r" version 1 {
  param sampled: quantity
  param defects: quantity
  when sampled > 0 and defects / sampled > 50% => REJECT
  otherwise => CONTINUE
}
`, 'test.dsl');
  assert.equal(run(p, { sampled: 0, defects: 0 }), 'CONTINUE');
  assert.equal(run(p, { sampled: 2, defects: 2 }), 'REJECT');
});

test('missing context parameter is a runtime fault', () => {
  assert.throws(() => run(program, { sampled: 5 }), /missing parameter 'batch_size'/);
});

test('no matching clause and no otherwise yields CONTINUE', () => {
  const { program: p } = compileRule(`
rule "r" version 1 {
  param a: quantity
  when a > 100 => REJECT
}
`, 'test.dsl');
  assert.equal(run(p, { a: 1 }), 'CONTINUE');
});
