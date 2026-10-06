import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VM, hashState, cloneState, NeedInputError, type Instruction } from '../src/index.js';

const program: Instruction[] = [
  { op: 'LOADI', reg: 0, imm: 3 },
  { op: 'STORE', addr: 5, reg: 0 },
  { op: 'LOAD', reg: 1, addr: 5 },
  { op: 'ADD', reg: 0, src: 1 },
  { op: 'OUT', reg: 0 },
  { op: 'HALT' },
];

test('vm executes arithmetic, heap and output', () => {
  const vm = new VM(program);
  while (!vm.halted) vm.step();
  assert.equal(vm.registers[0], 6);
  assert.equal(vm.heap[5], 3);
  assert.deepEqual(vm.output, [6]);
});

test('vm snapshot/restore round-trips full state', () => {
  const vm = new VM(program);
  vm.step();
  vm.step();
  const snap = vm.snapshot();
  vm.step();
  vm.step();
  vm.restore(snap);
  assert.equal(vm.pc, 2);
  assert.equal(vm.heap[5], 3);
  assert.equal(hashState(vm.snapshot()), hashState(snap));
});

test('state hash is stable and sensitive to changes', () => {
  const vm = new VM(program);
  const a = hashState(vm.snapshot());
  const b = hashState(cloneState(vm.snapshot()));
  assert.equal(a, b);
  vm.step();
  assert.notEqual(hashState(vm.snapshot()), a);
});

test('IN without queued input raises NeedInputError', () => {
  const vm = new VM([{ op: 'IN', reg: 0 }, { op: 'HALT' }]);
  assert.throws(() => vm.step(), NeedInputError);
  vm.queueInput(42);
  vm.step();
  assert.equal(vm.registers[0], 42);
  assert.equal(vm.inputsConsumed, 1);
});
