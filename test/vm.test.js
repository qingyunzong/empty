import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/compiler.js';
import { VM, DROPPED } from '../src/vm.js';
import { ProcessingError, CrashError } from '../src/errors.js';

const run1 = (src, record, opts) => new VM(compile(src), opts).execRecord(record, 0);

test('arithmetic and set', () => {
  const out = run1('set c 3\nmul amount price qty\nsub left amount c\nadd plus amount 2', { price: 4, qty: 5 });
  assert.equal(out.amount, 20);
  assert.equal(out.left, 17);
  assert.equal(out.plus, 22);
  assert.equal(out.c, 3);
});

test('clamp keeps in-range values and clamps out-of-bounds without failing', () => {
  const src = 'clamp score 0 100';
  assert.equal(run1(src, { score: 50 }).score, 50);
  assert.equal(run1(src, { score: 250 }).score, 100);
  assert.equal(run1(src, { score: -7 }).score, 0);
});

test('filter drops non-matching records', () => {
  const src = 'filter status == "active"';
  assert.equal(run1(src, { status: 'inactive' }), DROPPED);
  assert.deepEqual(run1(src, { status: 'active' }), { status: 'active' });
});

test('conditional jumps take both branches', () => {
  const src = 'if x > 10 goto big\nset tag "small"\njmp end\nlabel big\nset tag "big"\nlabel end';
  assert.equal(run1(src, { x: 5 }).tag, 'small');
  assert.equal(run1(src, { x: 50 }).tag, 'big');
});

test('map resolves table lookups and reports misses', () => {
  const src = '#!table rates\nUSD,1.0\nEUR,1.1\n#!correction main\nmap rate = rates[cur]';
  assert.equal(run1(src, { cur: 'EUR' }).rate, 1.1);
  assert.throws(() => run1(src, { cur: 'JPY' }), (e) => e instanceof ProcessingError && e.type === 'LookupMiss');
});

test('missing fields and division by zero raise ProcessingError', () => {
  assert.throws(() => run1('mul a x y', { x: 1 }), (e) => e.type === 'MissingField' && e.seq === 0);
  assert.throws(() => run1('div a x y', { x: 1, y: 0 }), (e) => e.type === 'DivByZero');
  assert.throws(() => run1('clamp s 0 1', {}), (e) => e.type === 'MissingField');
  assert.throws(() => run1('add a x 1', { x: 'nope' }), (e) => e.type === 'TypeMismatch');
});

test('crashAfter throws CrashError after exactly N executed instructions', () => {
  const program = compile('set a 1\nset b 2\nset c 3');
  const vm = new VM(program, { crashAfter: 2 });
  assert.throws(() => vm.execRecord({}, 0), (e) => e instanceof CrashError && e.afterInstruction === 2);
  assert.equal(vm.instrCount, 2);
  const ok = new VM(program, { crashAfter: 4 });
  assert.deepEqual(ok.execRecord({}, 0), { a: 1, b: 2, c: 3 });
});
