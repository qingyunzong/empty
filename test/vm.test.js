import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSource, VM } from '../src/index.js';
import { MACHINE_DSL } from './helpers.js';

function makeVM() {
  return new VM(compileSource(MACHINE_DSL));
}

function value(vm, name) {
  return vm.snapshot().values[name];
}

test('acceptance 1: normal startup sequence with timer-driven valve', () => {
  const vm = makeVM();
  const steps = [
    { tick: 0, cmd: 'set_input', signal: 'door_closed', value: true },
    { tick: 1, cmd: 'set_input', signal: 'product_present', value: true },
    { tick: 2, cmd: 'set_output', signal: 'motor', value: true },
    { tick: 3, cmd: 'start_timer', signal: 'fill_timer', ms: 0 },
    { tick: 4, cmd: 'advance', ms: 600 },
  ];
  for (const cmd of steps) {
    const r = vm.applyCommand(cmd);
    assert.ok(r.accepted, `${cmd.cmd} should be accepted: ${r.reason}`);
  }
  assert.equal(value(vm, 'motor'), true);
  // guard fired once the timer reached 500ms: valve opened atomically at commit
  assert.equal(value(vm, 'fill_valve'), 'open');
  // jam interlock stops the motor via a device rule
  const r = vm.applyCommand({ tick: 5, cmd: 'set_input', signal: 'filler.jammed', value: true });
  assert.ok(r.accepted);
  assert.equal(value(vm, 'motor'), false);
});

test('acceptance 2: motor start with door open is rejected; undo does not change state', () => {
  const vm = makeVM();
  const before = vm.snapshot();
  const r = vm.applyCommand({ tick: 0, cmd: 'set_output', signal: 'motor', value: true });
  assert.equal(r.accepted, false);
  assert.match(r.reason, /invariant violated: not \(motor and not door_closed\)/);
  assert.deepEqual(vm.snapshot(), before, 'rejected command leaves state fully unchanged');

  // rejected commands are not recorded: there is nothing to undo
  const u = vm.applyCommand({ tick: 1, cmd: 'undo' });
  assert.equal(u.accepted, false);
  assert.match(u.reason, /nothing to undo/);
  assert.deepEqual(vm.snapshot(), before, 'undo after a rejected command changes nothing');
});

test('acceptance 3: undo/redo around accepted commands; redo cleared by a new command', () => {
  const vm = makeVM();
  vm.applyCommand({ tick: 0, cmd: 'set_input', signal: 'door_closed', value: true });
  vm.applyCommand({ tick: 1, cmd: 'set_output', signal: 'motor', value: true });
  assert.equal(value(vm, 'motor'), true);

  const u1 = vm.applyCommand({ tick: 2, cmd: 'undo' });
  assert.ok(u1.accepted);
  assert.equal(value(vm, 'motor'), false);
  assert.equal(value(vm, 'door_closed'), true);

  const u2 = vm.applyCommand({ tick: 3, cmd: 'undo' });
  assert.ok(u2.accepted);
  assert.equal(value(vm, 'door_closed'), false);

  const r1 = vm.applyCommand({ tick: 4, cmd: 'redo' });
  assert.ok(r1.accepted);
  assert.equal(value(vm, 'door_closed'), true);
  const r2 = vm.applyCommand({ tick: 5, cmd: 'redo' });
  assert.ok(r2.accepted);
  assert.equal(value(vm, 'motor'), true);

  // undo then a NEW command: redo is no longer available
  vm.applyCommand({ tick: 6, cmd: 'undo' });
  const accepted = vm.applyCommand({ tick: 7, cmd: 'set_input', signal: 'product_present', value: true });
  assert.ok(accepted.accepted);
  const r3 = vm.applyCommand({ tick: 8, cmd: 'redo' });
  assert.equal(r3.accepted, false);
  assert.match(r3.reason, /nothing to redo/);
});

test('acceptance 4: commands at the same tick are applied strictly in input order', () => {
  // order A: motor first (door still open -> rejected), then door closes
  const a = makeVM();
  const a1 = a.applyCommand({ tick: 7, cmd: 'set_output', signal: 'motor', value: true });
  const a2 = a.applyCommand({ tick: 7, cmd: 'set_input', signal: 'door_closed', value: true });
  assert.equal(a1.accepted, false);
  assert.equal(a2.accepted, true);
  assert.equal(value(a, 'motor'), false);

  // order B: same tick, door closes first, then motor start is legal
  const b = makeVM();
  const b1 = b.applyCommand({ tick: 7, cmd: 'set_input', signal: 'door_closed', value: true });
  const b2 = b.applyCommand({ tick: 7, cmd: 'set_output', signal: 'motor', value: true });
  assert.equal(b1.accepted, true);
  assert.equal(b2.accepted, true);
  assert.equal(value(b, 'motor'), true);
});

test('runtime type checks: wrong signal kind and wrong value type are rejected', () => {
  const vm = makeVM();
  let r = vm.applyCommand({ tick: 0, cmd: 'set_input', signal: 'motor', value: true });
  assert.equal(r.accepted, false);
  assert.match(r.reason, /not an input/);
  r = vm.applyCommand({ tick: 1, cmd: 'set_output', signal: 'door_closed', value: true });
  assert.equal(r.accepted, false);
  assert.match(r.reason, /not an output/);
  r = vm.applyCommand({ tick: 2, cmd: 'set_input', signal: 'door_closed', value: 'yes' });
  assert.equal(r.accepted, false);
  assert.match(r.reason, /expected bool/);
  r = vm.applyCommand({ tick: 3, cmd: 'set_output', signal: 'fill_valve', value: 'sideways' });
  assert.equal(r.accepted, false);
  assert.match(r.reason, /expected one of closed, open/);
  r = vm.applyCommand({ tick: 4, cmd: 'set_input', signal: 'ghost', value: true });
  assert.equal(r.accepted, false);
  assert.match(r.reason, /unknown signal 'ghost'/);
});

test('interlock: door cannot be opened while the motor runs', () => {
  const vm = makeVM();
  vm.applyCommand({ tick: 0, cmd: 'set_input', signal: 'door_closed', value: true });
  vm.applyCommand({ tick: 1, cmd: 'set_output', signal: 'motor', value: true });
  const r = vm.applyCommand({ tick: 2, cmd: 'set_input', signal: 'door_closed', value: false });
  assert.equal(r.accepted, false);
  assert.match(r.reason, /invariant violated/);
  assert.equal(value(vm, 'door_closed'), true);
  assert.equal(value(vm, 'motor'), true);
});
