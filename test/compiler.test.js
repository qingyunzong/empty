import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/compiler.js';

test('compiles map/clamp/filter/if into bytecode with jumps', () => {
  const { code, csvRows } = compile([
    '#!correction',
    'map total = price * qty',
    'clamp price 0 100',
    'filter qty > 0',
    'if qty >= 4 then bonus = qty * 10',
    '#!end',
  ].join('\n'));
  assert.deepEqual(code.slice(0, 4), [
    { op: 'LOAD', field: 'price' },
    { op: 'LOAD', field: 'qty' },
    { op: 'MUL' },
    { op: 'STORE', field: 'total' },
  ]);
  assert.deepEqual(code[4], { op: 'CLAMP', field: 'price', min: 0, max: 100 });
  const filterJz = code.findIndex((i) => i.op === 'JZ');
  const dropIndex = code.findIndex((i) => i.op === 'DROP');
  const haltIndex = code.findIndex((i) => i.op === 'HALT');
  assert.equal(code[filterJz].target, dropIndex);
  const ifJz = code.findIndex((i, idx) => i.op === 'JZ' && idx !== filterJz);
  assert.equal(code[ifJz].target, haltIndex);
  assert.ok(dropIndex > haltIndex, 'DROP lives after HALT so fallthrough halts');
  assert.equal(csvRows.length, 0);
});

test('collects CSV rows outside directive blocks', () => {
  const { csvRows } = compile('id,price\n1,10\n#!correction\nmap a = 1\n#!end');
  assert.deepEqual(csvRows.map((r) => r.fields), [['id', 'price'], ['1', '10']]);
});

test('rejects unknown directives and clamp with min > max', () => {
  assert.throws(() => compile('#!correction\nfrob x\n#!end'), /unknown directive/);
  assert.throws(() => compile('#!correction\nclamp p 10 2\n#!end'), /min greater than max/);
});
