const test = require('node:test');
const assert = require('node:assert/strict');
const { VM, VmError } = require('../dist/index.js');

// Emits (3+4)*2, trunc(7/2), 7%2  ->  [14, 3, 1]
const arithProgram = [
  { op: 'push', value: 3 },
  { op: 'push', value: 4 },
  { op: 'add' },
  { op: 'push', value: 2 },
  { op: 'mul' },
  { op: 'emit' },
  { op: 'push', value: 7 },
  { op: 'push', value: 2 },
  { op: 'div' },
  { op: 'emit' },
  { op: 'push', value: 7 },
  { op: 'push', value: 2 },
  { op: 'mod' },
  { op: 'emit' },
  { op: 'halt' },
];

// Recursive factorial: fact(5) = 120, emitted once. Exercises call/ret.
const factProgram = [
  { op: 'push', value: 5 },   // 0
  { op: 'call', target: 4 },  // 1
  { op: 'emit' },             // 2
  { op: 'halt' },             // 3
  // fact (addr 4): in [n] -> out [n!]
  { op: 'dup' },              // 4
  { op: 'jz', target: 12 },   // 5
  { op: 'dup' },              // 6
  { op: 'push', value: 1 },   // 7
  { op: 'sub' },              // 8
  { op: 'call', target: 4 },  // 9
  { op: 'mul' },              // 10
  { op: 'ret' },              // 11
  // base (addr 12): stack [0] -> [1]
  { op: 'pop' },              // 12
  { op: 'push', value: 1 },   // 13
  { op: 'ret' },              // 14
];

// Emits 1..5 with a yield after each emit; counter lives in the heap.
const yieldProgram = [
  { op: 'push', value: 1 },   // 0
  { op: 'store', addr: 0 },   // 1
  // loop (addr 2):
  { op: 'load', addr: 0 },    // 2
  { op: 'emit' },             // 3
  { op: 'yield' },            // 4
  { op: 'load', addr: 0 },    // 5
  { op: 'push', value: 1 },   // 6
  { op: 'add' },              // 7
  { op: 'dup' },              // 8
  { op: 'store', addr: 0 },   // 9
  { op: 'push', value: 6 },   // 10
  { op: 'sub' },              // 11
  { op: 'jz', target: 14 },   // 12
  { op: 'jmp', target: 2 },   // 13
  { op: 'halt' },             // 14
];

function jsonRoundTrip(snap) {
  return JSON.parse(JSON.stringify(snap));
}

// Run the program uninterrupted, then verify that restoring a snapshot
// taken at *every* instruction boundary (JSON round-tripped) and running
// to completion produces the exact same final state.
function assertSnapshotRestoreAtEveryBoundary(program) {
  const reference = new VM(program);
  reference.runToCompletion();
  const expected = reference.snapshot();

  const walker = new VM(program);
  const boundaries = [];
  while (!walker.isHalted) {
    boundaries.push(walker.snapshot());
    walker.step();
  }
  boundaries.push(walker.snapshot()); // final halted state
  assert.ok(boundaries.length > 1, 'expected at least one boundary');

  for (const snap of boundaries) {
    const restored = VM.restore(program, jsonRoundTrip(snap));
    restored.runToCompletion();
    assert.deepStrictEqual(restored.snapshot(), expected);
  }
}

test('arithmetic instructions produce expected output', () => {
  const vm = new VM(arithProgram);
  vm.runToCompletion();
  assert.deepStrictEqual([...vm.output], [14, 3, 1]);
});

test('call/ret computes factorial recursively', () => {
  const vm = new VM(factProgram);
  vm.runToCompletion();
  assert.deepStrictEqual([...vm.output], [120]);
});

test('heap store/load and yield loop emit 1..5', () => {
  const vm = new VM(yieldProgram);
  vm.runToCompletion();
  assert.deepStrictEqual([...vm.output], [1, 2, 3, 4, 5]);
});

test('load of untouched heap cell defaults to 0', () => {
  const vm = new VM([
    { op: 'load', addr: 42 },
    { op: 'emit' },
    { op: 'halt' },
  ]);
  vm.runToCompletion();
  assert.deepStrictEqual([...vm.output], [0]);
});

test('run() suspends at yield and resumes with identical output', () => {
  const uninterrupted = new VM(yieldProgram);
  uninterrupted.runToCompletion();

  const vm = new VM(yieldProgram);
  const chunks = [];
  let result;
  do {
    result = vm.run();
    chunks.push([...vm.output].length);
  } while (result === 'yielded');
  // one yield per emitted value, plus the final halted run
  assert.deepStrictEqual(chunks, [1, 2, 3, 4, 5, 5]);
  assert.deepStrictEqual([...vm.output], [...uninterrupted.output]);
});

test('snapshot/restore at yield boundary resumes with same output', () => {
  const reference = new VM(yieldProgram);
  reference.runToCompletion();

  const vm = new VM(yieldProgram);
  while (!vm.isYielded) vm.step();
  const restored = VM.restore(yieldProgram, jsonRoundTrip(vm.snapshot()));
  restored.runToCompletion();
  assert.deepStrictEqual(restored.snapshot(), reference.snapshot());
});

test('snapshot captures pc, call stack and heap mid-call', () => {
  const vm = new VM(factProgram);
  vm.step(); // push 5
  vm.step(); // call fact
  vm.step(); // dup
  vm.step(); // jz (not taken)
  vm.step(); // dup
  vm.step(); // push 1
  vm.step(); // sub
  vm.step(); // call fact (nested)
  const snap = vm.snapshot();
  assert.equal(snap.pc, 4);
  assert.deepStrictEqual(snap.callStack, [2, 10]);
  assert.deepStrictEqual(snap.stack, [5, 4]);
  assert.deepStrictEqual(snap.heap, []);

  const heapVm = new VM(yieldProgram);
  heapVm.step(); // push 1
  heapVm.step(); // store 0
  assert.deepStrictEqual(heapVm.snapshot().heap, [[0, 1]]);
});

test('snapshot/restore at every instruction boundary matches uninterrupted run', () => {
  assertSnapshotRestoreAtEveryBoundary(arithProgram);
  assertSnapshotRestoreAtEveryBoundary(factProgram);
  assertSnapshotRestoreAtEveryBoundary(yieldProgram);
});

function assertErrorLeavesStateUnchanged(program, stepsBeforeError) {
  const vm = new VM(program);
  for (let i = 0; i < stepsBeforeError; i += 1) vm.step();
  const before = vm.snapshot();
  assert.throws(() => vm.step(), VmError);
  assert.deepStrictEqual(vm.snapshot(), before);
}

test('illegal jmp target does not change state', () => {
  assertErrorLeavesStateUnchanged(
    [{ op: 'push', value: 1 }, { op: 'jmp', target: 99 }, { op: 'halt' }],
    1,
  );
  assertErrorLeavesStateUnchanged(
    [{ op: 'push', value: 1 }, { op: 'jmp', target: -1 }, { op: 'halt' }],
    1,
  );
});

test('illegal jz/call targets do not change state', () => {
  assertErrorLeavesStateUnchanged(
    [{ op: 'push', value: 0 }, { op: 'jz', target: 42 }, { op: 'halt' }],
    1,
  );
  assertErrorLeavesStateUnchanged(
    [{ op: 'push', value: 7 }, { op: 'call', target: 100 }, { op: 'halt' }],
    1,
  );
});

test('stack underflow does not change state', () => {
  assertErrorLeavesStateUnchanged([{ op: 'pop' }, { op: 'halt' }], 0);
  assertErrorLeavesStateUnchanged([{ op: 'add' }, { op: 'halt' }], 0);
  assertErrorLeavesStateUnchanged(
    [{ op: 'push', value: 1 }, { op: 'add' }, { op: 'halt' }],
    1,
  );
  assertErrorLeavesStateUnchanged([{ op: 'emit' }, { op: 'halt' }], 0);
  assertErrorLeavesStateUnchanged([{ op: 'dup' }, { op: 'halt' }], 0);
  assertErrorLeavesStateUnchanged(
    [{ op: 'push', value: 1 }, { op: 'swap' }, { op: 'halt' }],
    1,
  );
  assertErrorLeavesStateUnchanged([{ op: 'store', addr: 0 }, { op: 'halt' }], 0);
});

test('ret with empty call stack does not change state', () => {
  assertErrorLeavesStateUnchanged([{ op: 'ret' }, { op: 'halt' }], 0);
});

test('division and modulo by zero do not change state', () => {
  const divZero = [
    { op: 'push', value: 1 },
    { op: 'push', value: 0 },
    { op: 'div' },
    { op: 'halt' },
  ];
  assertErrorLeavesStateUnchanged(divZero, 2);
  const modZero = [
    { op: 'push', value: 1 },
    { op: 'push', value: 0 },
    { op: 'mod' },
    { op: 'halt' },
  ];
  assertErrorLeavesStateUnchanged(modZero, 2);
});

test('stepping a halted VM throws', () => {
  const vm = new VM([{ op: 'halt' }]);
  vm.runToCompletion();
  assert.throws(() => vm.step(), VmError);
});
