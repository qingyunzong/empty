import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/compiler.js';

test('compiles arithmetic, clamp, filter and resolves jump labels', () => {
  const program = compile([
    '#!correction main',
    'mul amount price qty',
    'clamp score 0 100',
    'filter status == "active"',
    'if amount > 50 goto big',
    'jmp done',
    'label big',
    'add amount amount 5',
    'label done',
    'div per amount qty',
  ].join('\n'));
  const ops = program.instrs.map((i) => i.op);
  assert.deepEqual(ops, ['MUL', 'CLAMP', 'FILTER', 'CMP', 'JIF', 'JMP', 'ADD', 'DIV', 'HALT']);
  assert.equal(program.instrs[4].target, 6); // JIF -> label big (ADD)
  assert.equal(program.instrs[5].target, 7); // JMP -> label done (DIV)
  assert.deepEqual(program.instrs[0].a, { field: 'price' });
  assert.deepEqual(program.instrs[6].b, { const: 5 });
  assert.deepEqual(program.instrs[2].value, { const: 'active' });
});

test('compiles #!table CSV blocks and map lookups', () => {
  const program = compile([
    '#!table rates',
    'USD,1.0',
    'EUR,1.1',
    '#!correction main',
    'map rate = rates[currency]',
  ].join('\n'));
  assert.deepEqual(program.tables.rates, { USD: 1.0, EUR: 1.1 });
  assert.deepEqual(program.instrs[0], { op: 'MAP', field: 'rate', table: 'rates', keyField: 'currency' });
});

test('rejects unknown labels, duplicate labels and unknown tables', () => {
  assert.throws(() => compile('goto nowhere'), /Unknown label 'nowhere'/);
  assert.throws(() => compile('label a\nlabel a'), /Duplicate label/);
  assert.throws(() => compile('map r = missing[k]'), /Unknown table 'missing'/);
  assert.throws(() => compile('USD,1.0'), /Unknown statement 'USD'/);
});

test('rejects malformed statements', () => {
  assert.throws(() => compile('add x 1'), /Malformed 'add'/);
  assert.throws(() => compile('clamp f 0'), /Malformed 'clamp'/);
  assert.throws(() => compile('filter f = 1'), /comparison operator/);
  assert.throws(() => compile('if a > 1 jump b'), /Expected 'goto'/);
  assert.throws(() => compile('bogus x y'), /Unknown statement/);
});
