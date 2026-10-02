import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/compiler.js';
import { execute, VMError, CrashError } from '../src/vm.js';

const run = (source, record, opts) => execute(compile(source).code, record, opts);

test('arithmetic, clamp and conditional map', () => {
  const { record, dropped } = run(
    '#!correction\nmap t = (a + b) * 2\nclamp t 0 10\nif t >= 10 then flag = 1\n#!end',
    { a: 3, b: 4 },
  );
  assert.equal(dropped, false);
  assert.deepEqual(record, { a: 3, b: 4, t: 10, flag: 1 });
});

test('clamp corrects out-of-range values instead of failing', () => {
  const { record } = run('#!correction\nclamp p 0 100\n#!end', { p: 250 });
  assert.equal(record.p, 100);
  const { record: low } = run('#!correction\nclamp p 0 100\n#!end', { p: -5 });
  assert.equal(low.p, 0);
});

test('filter drops records failing the predicate', () => {
  const dropped = run('#!correction\nfilter qty > 0\n#!end', { qty: 0 });
  assert.equal(dropped.dropped, true);
  const kept = run('#!correction\nfilter qty > 0\n#!end', { qty: 3 });
  assert.equal(kept.dropped, false);
});

test('missing field raises VMError with record index', () => {
  assert.throws(
    () => run('#!correction\nmap t = missing * 2\n#!end', { a: 1 }, { recordIndex: 7 }),
    (err) => err instanceof VMError && /missing field "missing"/.test(err.message) && err.recordIndex === 7,
  );
});

test('division by zero raises VMError', () => {
  assert.throws(
    () => run('#!correction\nmap r = price / qty\n#!end', { price: 1, qty: 0 }),
    /division by zero/,
  );
});

test('crashAfter triggers CrashError after the Nth instruction', () => {
  const counter = { count: 0 };
  assert.throws(
    () => run('#!correction\nmap t = a * 2\n#!end', { a: 1 }, { counter, crashAfter: 2 }),
    (err) => err instanceof CrashError && /#2/.test(err.message),
  );
  assert.equal(counter.count, 2);
});
