import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileRule } from '../src/compiler.js';
import { run } from '../src/vm.js';

const SRC = `rule "AQL" version 1 {
  param batch_size: quantity
  param sampled: quantity
  param defects: quantity
  param worst: defect_level
  let sample_size: quantity = max(1, floor(batch_size * 10%))
  let accept_max: quantity = floor(sample_size * 5%)
  decide {
    when worst >= critical -> REJECT
    when defects >= accept_max + 1 -> REJECT
    when sampled >= sample_size and defects <= accept_max -> ACCEPT
    otherwise -> CONTINUE
  }
}`;

const prog = compileRule(SRC);
const base = { batch_size: 1000, worst: 'minor' }; // sample_size=100, accept_max=5

test('three decision paths: ACCEPT, REJECT, CONTINUE', () => {
  assert.equal(run(prog, { ...base, sampled: 100, defects: 3 }), 'ACCEPT');
  assert.equal(run(prog, { ...base, sampled: 100, defects: 9 }), 'REJECT');
  assert.equal(run(prog, { ...base, sampled: 40, defects: 1 }), 'CONTINUE');
});

test('boundary: defects == accept_max accepts, == accept_max+1 rejects', () => {
  assert.equal(run(prog, { ...base, sampled: 100, defects: 5 }), 'ACCEPT');
  assert.equal(run(prog, { ...base, sampled: 100, defects: 6 }), 'REJECT');
});

test('CONTINUE is a legitimate pending state, not an error', () => {
  const d = run(prog, { ...base, sampled: 0, defects: 0 });
  assert.equal(d, 'CONTINUE');
  // early rejection still possible before the sample is complete
  assert.equal(run(prog, { ...base, sampled: 10, defects: 6 }), 'REJECT');
});

test('critical defect level rejects immediately', () => {
  assert.equal(run(prog, { ...base, sampled: 1, defects: 1, worst: 'critical' }), 'REJECT');
});

test('missing input parameter raises VMError', () => {
  assert.throws(() => run(prog, { batch_size: 100, sampled: 1, defects: 0 }), /missing input parameter 'worst'/);
});
