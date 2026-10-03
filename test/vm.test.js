import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OP, compileSite, link, disassemble } from '../src/compiler.js';
import { VM } from '../src/vm.js';
import { siteOf } from './helpers.js';

test('VM accumulates load over 15-minute slots', () => {
  const vm = new VM(4);
  const code = [
    [OP.ADDRANGE, 0, 2, 1000],
    [OP.ADDRANGE, 1, 3, 500],
    [OP.HALT],
  ];
  const r = vm.run(code);
  assert.equal(r.ok, true);
  assert.deepEqual(Array.from(vm.load), [1000, 1500, 500, 0]);
  assert.equal(vm.peakW(), 1500);
});

test('VM rejects load inside a maintenance (BLOCK) window', () => {
  const vm = new VM(4);
  const code = [
    [OP.BLOCK, 1, 3],
    [OP.ADDRANGE, 2, 4, 1000],
    [OP.CHKBLOCK],
    [OP.HALT],
  ];
  const r = vm.run(code);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'maintenance-window');
  assert.equal(r.slot, 2);
});

test('VM enforces peak limit', () => {
  const vm = new VM(2);
  const code = [
    [OP.ADDRANGE, 0, 2, 900],
    [OP.ADDRANGE, 1, 2, 200],
    [OP.CHKPEAK, 1000],
    [OP.HALT],
  ];
  const r = vm.run(code);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'peak-limit');
  assert.equal(r.slot, 1);
});

test('compiler emits static blocks, task ranges and checks', () => {
  const site = siteOf(`
    site S {
      slots 4
      tariff 1
      peakLimit 5 kW
      maintenance 00:00 .. 00:15
      task a { power 1 kW duration 30 min window 00:00 .. 01:00 }
    }
  `);
  const program = compileSite(site);
  assert.deepEqual(program.staticCode, [[OP.BLOCK, 0, 1]]);
  const code = link(program, [[[1, 3]]]);
  assert.ok(code.some((i) => i[0] === OP.ADDRANGE && i[1] === 1 && i[2] === 3 && i[3] === 1000));
  assert.ok(code.some((i) => i[0] === OP.CHKPEAK && i[1] === 5000));
  assert.equal(code[code.length - 1][0], OP.HALT);
  assert.ok(disassemble(code).includes('ADDRANGE 1 3 1000'));
});
