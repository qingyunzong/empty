'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Interpreter } = require('../src/interpreter');

test('A: automatic start requested with door open is rejected', () => {
  const interp = new Interpreter();
  interp.run([
    { clock: 1, seq: 1, source: 'hmi', type: 'key_grant', key: 'K1', level: 'team' },
    // maintenance mode allows the door to be opened:
    { clock: 2, seq: 2, source: 'door', type: 'door', state: 'open' },
    // but auto mode and automatic start are refused while it is open:
    { clock: 3, seq: 3, source: 'hmi', type: 'mode_request', mode: 'auto' },
    { clock: 4, seq: 4, source: 'plc', type: 'auto_start' },
  ]);
  assert.equal(interp.door, 'open');
  assert.equal(interp.mode, 'maintenance');
  assert.equal(interp.running, false);
  assert.equal(interp.violations.length, 2);
  assert.match(interp.violations[0].reason, /door is open/);
  assert.match(interp.violations[1].reason, /maintenance mode forbids automatic start/);
});

test('B: flow after key revocation and restore', () => {
  const interp = new Interpreter();
  interp.run([
    { clock: 1, seq: 1, source: 'hmi', type: 'key_grant', key: 'K1', level: 'team' },
    { clock: 2, seq: 2, source: 'hmi', type: 'mode_request', mode: 'auto' },
    { clock: 3, seq: 3, source: 'plc', type: 'auto_start' },
  ]);
  assert.equal(interp.running, true);

  interp.run([{ clock: 4, seq: 4, source: 'keys', type: 'key_revoke', key: 'K1' }]);
  const snap = interp.snapshot();
  assert.deepEqual(snap.keys, [], 'permission snapshot updates immediately');
  assert.equal(snap.running, false);
  assert.ok(snap.decel, 'deceleration window started');
  assert.equal(snap.mode, 'auto', 'window must complete before mode changes');

  interp.run([{ clock: 6, seq: 5, source: 'door', type: 'door', state: 'closed' }]);
  assert.equal(interp.mode, 'maintenance', 'pending safe mode applied at window end');

  // restore: re-grant key, re-enter auto, restart
  interp.run([
    { clock: 7, seq: 6, source: 'hmi', type: 'key_grant', key: 'K2', level: 'team' },
    { clock: 8, seq: 7, source: 'hmi', type: 'mode_request', mode: 'auto' },
    { clock: 9, seq: 8, source: 'plc', type: 'auto_start' },
  ]);
  assert.equal(interp.mode, 'auto');
  assert.equal(interp.running, true);
});

test('C: three events at the same clock resolve deterministically', () => {
  const concurrent = [
    { clock: 2, seq: 1, source: 'plc', type: 'auto_start' },
    { clock: 2, seq: 2, source: 'door', type: 'door', state: 'open' },
    { clock: 2, seq: 3, source: 'hmi', type: 'mode_request', mode: 'maintenance' },
  ];
  const prefix = [
    { clock: 1, seq: 1, source: 'hmi', type: 'key_grant', key: 'K1', level: 'team' },
    { clock: 1, seq: 2, source: 'hmi', type: 'mode_request', mode: 'auto' },
  ];
  const permutations = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ];
  const outputs = permutations.map((perm) => {
    const interp = new Interpreter();
    interp.run([...prefix, ...perm.map((i) => concurrent[i])]);
    return JSON.stringify({ transitions: interp.transitions, violations: interp.violations });
  });
  for (const out of outputs) assert.equal(out, outputs[0], 'output must not depend on arrival order');

  const interp = new Interpreter();
  interp.run([...prefix, ...concurrent]);
  assert.equal(interp.running, false);
  assert.equal(interp.door, 'open');
  assert.ok(interp.decel, 'door event (highest safety level) wins and starts decel');
  const kinds = interp.violations.map((v) => [v.event.type, v.kind]);
  assert.deepEqual(kinds, [
    ['mode_request', 'discarded'],
    ['auto_start', 'discarded'],
  ]);
});
